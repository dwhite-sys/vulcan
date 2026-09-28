"""Secure General-WS client over real TCP (mirrors the renderer's protocol)."""
import base64, json, os, sys, threading, time, uuid
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from websockets.sync.client import connect
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else ".")
from vulcan import secure_ws

class Client:
    def __init__(self, url):
        self.ws = connect(url, max_size=None, open_timeout=120)
        hello = json.loads(self.ws.recv())
        private = x25519.X25519PrivateKey.generate()
        public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        prefix = os.urandom(4)
        self.ws.send(json.dumps({"type": "handshake/client", "version": 1, "ephemeral": base64.b64encode(public).decode(), "send_prefix": base64.b64encode(prefix).decode()}))
        se = base64.b64decode(hello["ephemeral"]); sp = base64.b64decode(hello["send_prefix"])
        shared = private.exchange(x25519.X25519PublicKey.from_public_bytes(se))
        c2s, s2c = secure_ws._derive_keys(shared, secure_ws._CONTEXT + base64.b64decode(hello["identity"]) + se + public + sp + prefix)
        self.enc, self.dec, self.sp, self.rp = AESGCM(c2s), AESGCM(s2c), prefix, sp
        self.ss = self.rs = 0
        assert json.loads(self.ws.recv())["type"] == "handshake/ready"
        self.responses, self.waiters, self.pushes, self.lock = {}, {}, [], threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()
    def _read(self):
        while True:
            try: raw = self.ws.recv()
            except Exception: return
            env = json.loads(raw); seq = env["sequence"]
            msg = json.loads(self.dec.decrypt(secure_ws._nonce(self.rp, seq), base64.b64decode(env["ciphertext"]), secure_ws._aad(seq)))
            self.rs += 1
            if msg.get("id"):
                self.responses[msg["id"]] = msg
                w = self.waiters.get(msg["id"]); w and w.set()
            else: self.pushes.append(msg["type"])
    def request(self, kind, payload, timeout=120):
        rid = uuid.uuid4().hex; w = self.waiters[rid] = threading.Event(); t = time.perf_counter()
        with self.lock:
            ct = self.enc.encrypt(secure_ws._nonce(self.sp, self.ss), json.dumps({"id": rid, "type": kind, "payload": payload}).encode(), secure_ws._aad(self.ss))
            self.ws.send(json.dumps({"type": "secure", "sequence": self.ss, "ciphertext": base64.b64encode(ct).decode()})); self.ss += 1
        if not w.wait(timeout): raise TimeoutError(kind)
        return self.responses.pop(rid), time.perf_counter() - t
    def close(self):
        try: self.ws.close()
        except Exception: pass
