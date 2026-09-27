from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from vulcan import secure_ws


def _raw_private(key):
    return key.private_bytes_raw()


def test_identity_creation_is_single_process_stable_under_concurrency(tmp_path, monkeypatch):
    monkeypatch.setattr(secure_ws.cfg, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(secure_ws, "_IDENTITY_FILE", tmp_path / "server-identity.ed25519")
    monkeypatch.setattr(secure_ws, "_IDENTITY_PRIVATE", None)

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _: _raw_private(secure_ws._load_or_create_identity()), range(64)))

    assert len(set(results)) == 1
    assert secure_ws._IDENTITY_FILE.exists()

    # Prove persistence, not merely the in-memory cache.
    monkeypatch.setattr(secure_ws, "_IDENTITY_PRIVATE", None)
    reloaded = _raw_private(secure_ws._load_or_create_identity())
    assert reloaded == results[0]
