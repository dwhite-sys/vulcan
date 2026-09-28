"""Separate process: repeatedly connect, register, list chats, open the busy chat."""
import sys, time, json
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, ".")
from client import Client
url, out = sys.argv[2], sys.argv[3]
with open(out, "a", buffering=1) as log:
    while True:
        t = time.time(); started = time.perf_counter()
        try:
            c = Client(url)
            _, reg = c.request("client/register", {"client_id": f"prober"}, timeout=120)
            _, lst = c.request("chats/list", {"summary_only": True}, timeout=120)
            _, opn = c.request("runs/subscribe", {"chat_id": "soak", "branch_refs": True, "include_chat": True}, timeout=120)
            c.close()
            log.write(json.dumps({"t": t, "total": time.perf_counter() - started, "register": reg, "list": lst, "open": opn}) + "\n")
        except Exception as exc:
            log.write(json.dumps({"t": t, "total": time.perf_counter() - started, "error": repr(exc)}) + "\n")
        time.sleep(0.25)
