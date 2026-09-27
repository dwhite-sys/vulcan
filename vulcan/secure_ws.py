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
import threading
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
# Frames at least this large are sealed/opened in a worker thread.
OFFLOAD_BYTES = 256 * 1024
_CONTEXT = b"vulcan-secure-session-v1\x00"
_IDENTITY_FILE = cfg.CONFIG_DIR / "server-identity.ed25519"
_IDENTITY_LOCK = threading.RLock()
_IDENTITY_PRIVATE: ed25519.Ed25519PrivateKey | None = None


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


# base64/json of one multi-megabyte string is a single C call that holds the
# GIL throughout (60-170 ms at 30-40 MB) and so freezes the event loop even
# from a worker thread. Large frames are processed in slices instead, with
# byte-identical results, releasing the GIL between slices.
_B64_ENCODE_SLICE = 3 * 256 * 1024   # multiple of 3 bytes
_B64_DECODE_SLICE = 4 * 256 * 1024   # multiple of 4 chars


def _b64_slices(data: bytes) -> list[str]:
    if len(data) <= _B64_ENCODE_SLICE:
        return [_b64(data)]
    view = memoryview(data)
    return [
        base64.b64encode(view[offset:offset + _B64_ENCODE_SLICE]).decode("ascii")
        for offset in range(0, len(data), _B64_ENCODE_SLICE)
    ]


def _b64_sliced(data: bytes) -> str:
    return "".join(_b64_slices(data))


def _unb64_sliced(value: str) -> bytes:
    if len(value) <= _B64_DECODE_SLICE:
        return _unb64(value)
    if len(value) % 4:
        raise ValueError("Invalid base64 length")
    return b"".join(
        base64.b64decode(value[offset:offset + _B64_DECODE_SLICE].encode("ascii"), validate=True)
        for offset in range(0, len(value), _B64_DECODE_SLICE)
    )


_CIPHERTEXT_KEY = '"ciphertext":"'


def _parse_envelope(raw: str) -> tuple[Any, int, str]:
    """(type, sequence, ciphertext) without JSON-parsing the huge ciphertext."""
    if len(raw) < OFFLOAD_BYTES:
        envelope = json.loads(raw)
        return envelope.get("type"), int(envelope["sequence"]), envelope["ciphertext"]
    start = raw.find(_CIPHERTEXT_KEY)
    if start < 0:
        envelope = json.loads(raw)
        return envelope.get("type"), int(envelope["sequence"]), envelope["ciphertext"]
    begin = start + len(_CIPHERTEXT_KEY)
    end = raw.find('"', begin)
    if end < 0:
        raise ValueError("Unterminated ciphertext")
    ciphertext = raw[begin:end]
    envelope = json.loads(raw[:start] + '"ciphertext":""' + raw[end + 1:])
    if not isinstance(envelope, dict) or "ciphertext" not in envelope:
        raise ValueError("Malformed secure envelope")
    return envelope.get("type"), int(envelope["sequence"]), ciphertext


def _raw_public(key: Any) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _load_or_create_identity() -> ed25519.Ed25519PrivateKey:
    """Return the process-stable server identity, creating it once if needed.

    Secure WebSocket handshakes can arrive concurrently during renderer startup.
    Identity creation therefore must not perform an unlocked check-then-create: that
    can make different handshakes in one server process present different identities.
    """
    global _IDENTITY_PRIVATE
    with _IDENTITY_LOCK:
        if _IDENTITY_PRIVATE is not None:
            return _IDENTITY_PRIVATE

        cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        if _IDENTITY_FILE.exists():
            raw = base64.b64decode(_IDENTITY_FILE.read_text().strip())
            _IDENTITY_PRIVATE = ed25519.Ed25519PrivateKey.from_private_bytes(raw)
            return _IDENTITY_PRIVATE

        key = ed25519.Ed25519PrivateKey.generate()
        raw = key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        # The lock serializes in-process creation. A unique temporary path avoids
        # the shared-.tmp race class and os.replace publishes only complete data.
        tmp = _IDENTITY_FILE.with_name(
            f"{_IDENTITY_FILE.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            with open(tmp, "x") as handle:
                handle.write(_b64(raw))
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, _IDENTITY_FILE)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

        _IDENTITY_PRIVATE = key
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
        plaintext = json.dumps(payload, default=str, separators=(",", ":")).encode("utf-8")
        await self.send_plaintext(plaintext)

    def _seal(self, plaintext: bytes, sequence: int) -> str:
        ciphertext = self.send_cipher.encrypt(
            _nonce(self.send_prefix, sequence), plaintext, _aad(sequence)
        )
        # Same bytes as json.dumps({...}, separators=(",", ":")): base64 needs
        # no JSON escaping, so the envelope is assembled directly.
        # One join: a single allocation/copy of the (possibly huge) frame.
        return "".join([
            '{"type":"secure","sequence":', str(int(sequence)), ',"ciphertext":"',
            *_b64_slices(ciphertext), '"}',
        ])

    async def send_plaintext(self, plaintext: bytes) -> None:
        """Encrypt and send one already-encoded application frame.

        Sequence assignment + write stay serialized under the lock. Large
        frames are sealed (AES-GCM + base64 + envelope) in a worker thread so
        a multi-megabyte hydration cannot monopolize the event loop that is
        also serving register/cancel/status for every other client.
        """
        async with self._send_lock:
            sequence = self.send_sequence
            if len(plaintext) >= OFFLOAD_BYTES:
                frame = await asyncio.to_thread(self._seal, plaintext, sequence)
            else:
                frame = self._seal(plaintext, sequence)
            await self.ws.send_text(frame)
            self.send_sequence += 1

    def _open(self, raw: str) -> Any:
        try:
            kind, sequence, encoded = _parse_envelope(raw)
            if kind != "secure":
                raise ValueError("Plaintext application frame rejected")
            if sequence != self.receive_sequence:
                raise ValueError(
                    f"Unexpected secure frame sequence {sequence}; expected {self.receive_sequence}"
                )
            if not isinstance(encoded, str):
                raise TypeError("ciphertext must be a string")
            ciphertext = _unb64_sliced(encoded)
            plaintext = self.receive_cipher.decrypt(
                _nonce(self.receive_prefix, sequence), ciphertext, _aad(sequence)
            )
            self.receive_sequence += 1
            return json.loads(plaintext.decode("utf-8"))
        except (KeyError, TypeError, ValueError, InvalidTag, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid secure WebSocket frame: {exc}") from exc

    async def receive_json(self) -> Any:
        message, _size = await self.receive_json_sized()
        return message

    async def receive_json_sized(self) -> tuple[Any, int]:
        """Receive one frame, returning it with its wire size.

        Receiving is inherently sequential (strict sequence numbers), but the
        decode of a large frame need not occupy the loop: other tasks keep
        running while a worker opens it. Order is preserved because the next
        receive only starts after this one returns.
        """
        raw = await self.ws.receive_text()
        if len(raw) >= OFFLOAD_BYTES:
            return await asyncio.to_thread(self._open, raw), len(raw)
        return self._open(raw), len(raw)
