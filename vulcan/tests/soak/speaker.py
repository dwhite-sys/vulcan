"""Separate process: keep chatting in one conversation; print per-message stats."""
import base64, json, os, random, subprocess, sys, time
tree, url, messages, probe_log = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
sys.path.insert(0, tree); sys.path.insert(0, ".")
from client import Client
rng = random.Random(3); W = "docker network python async sqlite".split()
words = lambda n: " ".join(rng.choice(W) for _ in range(n))
c = Client(url)
reg, _ = c.request("client/register", {"client_id": "speaker", "capabilities": ["run-delta-v1"]})
caps = reg["payload"].get("capabilities") or []
chat = {"schemaVersion": 2, "id": "soak", "title": "New Chat", "createdAt": "c", "updatedAt": "u", "events": []}
options = {"provider": {"baseUrl": "http://provider.test/v1", "model": "m", "networkPointOfView": "server"}, "settings": {"toolMode": "broad", "cliWorkspaceEnabled": False}, "modelVision": False}
image = "data:image/png;base64," + base64.b64encode(os.urandom(300_000)).decode()
for m in range(messages):
    user = {"id": f"soak-u{m}", "type": "user_message", "content": f"message {m}: " + words(40), "timestamp": "t"}
    if m == 0: user["attachments"] = [{"name": "shot.png", "type": "image/png", "size": 300000, "dataUrl": image}]
    chat["events"].append(user)
    refs = "branch-refs-v1" in caps  # the updated renderer sends compact topology
    chat["branching"] = {"version": 1, "currentBranchId": "root",
        "nodes": [({"eventId": e["id"]} if refs else {"event": e}) | {"parentId": chat["events"][i - 1]["id"] if i else None} for i, e in enumerate(chat["events"])],
        **({"offPathEvents": []} if refs else {}),
        "branches": [{"id": "root", "parentBranchId": None, "origin": "root", "title": "Main", "titleSource": "auto", "createdAt": "c", "updatedAt": "u", "headEventId": user["id"]}]}
    payload = {"chat": chat, "options": options, "capabilities": ["run-delta-v1"]}
    if m and "runs-start-ref-v1" in caps:
        meta = {k: v for k, v in chat.items() if k != "events"}
        payload = {**payload, "chat": {**meta, "events": []}, "chat_ref": {"base_len": len(chat["events"]) - 1, "base_last_id": chat["events"][-2]["id"], "new_events": [user]}}
    start = time.time(); t0 = time.perf_counter()
    try:
        _, start_latency = c.request("runs/start", payload, timeout=60)
        while True:
            st, _ = c.request("runs/status", {"chat_id": "soak"}, timeout=300)
            if st["payload"]["status"] in ("idle", "complete"): break
            time.sleep(0.1)
    except Exception as exc:
        print(f"message {m+1}: FAILED {exc!r} after {time.perf_counter()-t0:.1f}s", flush=True); break
    run = time.perf_counter() - t0
    time.sleep(2.0)  # aftermath: indexing + tagging
    sub, open_latency = c.request("runs/subscribe", {"chat_id": "soak", "branch_refs": True, "include_chat": True}, timeout=300)
    chat = sub["payload"]["chat"]
    probes = [json.loads(l) for l in open(probe_log) if json.loads(l)["t"] >= start]
    worst = max((p["total"] for p in probes), default=0)
    errors = sum(1 for p in probes if "error" in p)
    lag = ""
    try:
        met, _ = c.request("server/metrics", {}, timeout=30); lag = f" loop-lag peak {met['payload']['loop_lag']['peak_ms']:.0f}ms"
    except Exception: pass
    size = len(json.dumps(chat)) / 1e6
    print(f"message {m+1:2d}: start-ack {start_latency*1000:5.0f}ms run {run:6.2f}s | 2nd client connect+list+open worst {worst*1000:6.0f}ms over {len(probes)} probes, errors {errors} | own reopen {open_latency*1000:5.0f}ms | chat {size:4.1f}MB{lag}", flush=True)
