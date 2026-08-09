"""Authenticated encrypted WebSocket transport for Vulcan.

The server signs a fresh X25519 ephemeral key with a persistent Ed25519 identity
key. The frontend pins that identity per endpoint (trust on first use). Both ends
then derive independent client→server and server→client AES-256-GCM keys with
HKDF-SHA256. Every post-handshake application frame is encrypted, authenticated,
and strictly sequence checked.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import dataclass, field
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import WebSocket

from vulcan import config as cfg

PROTOCOL_VERSION = 1
_CONTEXT = b"vulcan-secure-session-v1\x00"
_IDENTITY_FILE = cfg.CONFIG_DIR / "server-identity.ed25519"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def _raw_public(key: Any) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _load_or_create_identity() -> ed25519.Ed25519PrivateKey:
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if _IDENTITY_FILE.exists():
        raw = base64.b64decode(_IDENTITY_FILE.read_text().strip())
        return ed25519.Ed25519PrivateKey.from_private_bytes(raw)

    key = ed25519.Ed25519PrivateKey.generate()
    raw = key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    tmp = _IDENTITY_FILE.with_suffix(".tmp")
    tmp.write_text(_b64(raw))
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, _IDENTITY_FILE)
    return key


def _derive_keys(shared: bytes, transcript: bytes) -> tuple[bytes, bytes]:
    # HKDF's salt is the handshake transcript digest.
    # cryptography's HKDF accepts bytes, not an active Hash object.
    digest = hashes.Hash(hashes.SHA256())
    digest.update(transcript)
    salt = digest.finalize()
    material = HKDF(
        algorithm=hashes.SHA256(),
        length=64,
        salt=salt,
        info=b"vulcan-secure-session-keys",
    ).derive(shared)
    return material[:32], material[32:]


def _nonce(prefix: bytes, sequence: int) -> bytes:
    if len(prefix) != 4:
        raise ValueError("Invalid nonce prefix")
    if sequence < 0 or sequence >= 2**64:
        raise ValueError("Sequence exhausted")
    return prefix + sequence.to_bytes(8, "big")


def _aad(sequence: int) -> bytes:
    return b"vulcan-frame-v1\x00" + sequence.to_bytes(8, "big")


@dataclass
class SecureWebSocketSession:
    ws: WebSocket
    send_cipher: AESGCM
    receive_cipher: AESGCM
    send_prefix: bytes
    receive_prefix: bytes
    send_sequence: int = 0
    receive_sequence: int = 0
    # Terminal sockets can emit status and PTY chunks from separate asyncio
    # tasks. Serialize encryption + sequence assignment + WebSocket writes so
    # frames cannot reuse or overtake sequence numbers.
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    @classmethod
    async def accept(cls, ws: WebSocket, *, timeout: float = 10.0) -> "SecureWebSocketSession":
        await ws.accept()

        identity = _load_or_create_identity()
        identity_public = _raw_public(identity.public_key())
        ephemeral = x25519.X25519PrivateKey.generate()
        ephemeral_public = _raw_public(ephemeral.public_key())
        server_prefix = os.urandom(4)
        signature = identity.sign(_CONTEXT + ephemeral_public + server_prefix)

        await ws.send_text(json.dumps({
            "type": "handshake/server",
            "version": PROTOCOL_VERSION,
            "identity": _b64(identity_public),
            "ephemeral": _b64(ephemeral_public),
            "signature": _b64(signature),
            "send_prefix": _b64(server_prefix),
        }, separators=(",", ":")))

        raw = await asyncio.wait_for(ws.receive_text(), timeout=timeout)
        try:
            client = json.loads(raw)
            if client.get("type") != "handshake/client":
                raise ValueError("Expected handshake/client")
            if int(client.get("version", 0)) != PROTOCOL_VERSION:
                raise ValueError("Unsupported secure-session version")
            client_public_raw = _unb64(client["ephemeral"])
            client_prefix = _unb64(client["send_prefix"])
            if len(client_public_raw) != 32 or len(client_prefix) != 4:
                raise ValueError("Invalid handshake key material")
        except Exception as exc:
            await ws.send_text(json.dumps({"type": "handshake/error", "message": str(exc)}))
            await ws.close(code=1002)
            raise

        client_public = x25519.X25519PublicKey.from_public_bytes(client_public_raw)
        shared = ephemeral.exchange(client_public)
        transcript = (
            _CONTEXT + identity_public + ephemeral_public + client_public_raw
            + server_prefix + client_prefix
        )
        client_to_server, server_to_client = _derive_keys(shared, transcript)

        session = cls(
            ws=ws,
            send_cipher=AESGCM(server_to_client),
            receive_cipher=AESGCM(client_to_server),
            send_prefix=server_prefix,
            receive_prefix=client_prefix,
        )
        await ws.send_text(json.dumps({"type": "handshake/ready", "version": PROTOCOL_VERSION}))
        return session

    async def send_json(self, payload: Any) -> None:
        async with self._send_lock:
            plaintext = json.dumps(payload, default=str, separators=(",", ":")).encode("utf-8")
            sequence = self.send_sequence
            ciphertext = self.send_cipher.encrypt(
                _nonce(self.send_prefix, sequence), plaintext, _aad(sequence)
            )
            await self.ws.send_text(json.dumps({
                "type": "secure",
                "sequence": sequence,
                "ciphertext": _b64(ciphertext),
            }, separators=(",", ":")))
            self.send_sequence += 1

    async def receive_json(self) -> Any:
        raw = await self.ws.receive_text()
        try:
            envelope = json.loads(raw)
            if envelope.get("type") != "secure":
                raise ValueError("Plaintext application frame rejected")
            sequence = int(envelope["sequence"])
            if sequence != self.receive_sequence:
                raise ValueError(
                    f"Unexpected secure frame sequence {sequence}; expected {self.receive_sequence}"
                )
            ciphertext = _unb64(envelope["ciphertext"])
            plaintext = self.receive_cipher.decrypt(
                _nonce(self.receive_prefix, sequence), ciphertext, _aad(sequence)
            )
            self.receive_sequence += 1
            return json.loads(plaintext.decode("utf-8"))
        except (KeyError, TypeError, ValueError, InvalidTag, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid secure WebSocket frame: {exc}") from exc
