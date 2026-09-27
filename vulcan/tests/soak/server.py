"""Out-of-process soak server: the real Vulcan app under uvicorn with a fake
provider/tool (no network, no Docker) and the indexing/tagging pipeline on."""
import asyncio, json, os, random, sys, tempfile, faulthandler, signal
faulthandler.register(signal.SIGUSR1, all_threads=True)
os.environ["VULCAN_CONFIG_DIR"] = tempfile.mkdtemp(prefix="soak-server-")
sys.path.insert(0, sys.argv[1])
from unittest import mock
from vulcan import agent_runtime as agent, recall, server, chats
import numpy as np

rng = random.Random(7); W = "docker network tailscale bread sourdough python async sqlite index vector".split()
words = lambda n, r=rng: " ".join(r.choice(W) for _ in range(n))
for index in range(int(sys.argv[3])):
    ev = []
    for turn in range(20):
        ev += [{"id": f"bg{index}-u{turn}", "type": "user_message", "content": words(30), "timestamp": "t"},
               {"id": f"bg{index}-t{turn}", "type": "tool", "tool": "read_file", "arguments": {}, "result": {"result": {"content": words(2500)}}, "status": "complete", "timestamp": "t"},
               {"id": f"bg{index}-a{turn}", "type": "assistant_text", "content": words(250), "status": "complete", "timestamp": "t"}]
    chats.save_chat({"schemaVersion": 2, "id": f"bg{index}", "title": f"Background {index}", "createdAt": "c", "updatedAt": "u", "events": ev})
if hasattr(chats, "wait_for_index"): chats.wait_for_index(600)

class Stub:
    def embed(self, texts):
        for text in texts: yield np.random.default_rng(abs(hash(text)) % 2**32).standard_normal(384).astype(np.float32)
recall.embedder = lambda: Stub()
tool_rng = random.Random(11)
async def provider(run, messages, tools, turn_id):
    # realistic pacing: ~2000 tokens/s bursts
    tool_turns = sum(1 for e in run.events if e.get("type") == "tool" and e.get("runId") == run.run_id)
    for i in range(120):
        run.stream_event({"type": "reasoning_delta", "delta": f"think{i} ", "wire": "reasoning"}, turn_id)
        if i % 10 == 0: await asyncio.sleep(0.005)
    if tool_turns < 4:
        call = {"id": f"call-{turn_id}", "type": "function", "function": {"name": "read_workspace_file", "arguments": json.dumps({"path": f"f{tool_turns}"})}}
        run.stream_event({"type": "tool_call_delta", "index": 0, "id": call["id"], "nameDelta": call["function"]["name"], "argumentsDelta": call["function"]["arguments"]}, turn_id)
        return {"thinking": "", "content": "", "toolCalls": [call]}
    for i in range(400):
        run.stream_event({"type": "text_delta", "delta": f"answer{i} "}, turn_id)
        if i % 10 == 0: await asyncio.sleep(0.005)
    return {"thinking": "", "content": "", "toolCalls": [], "providerTerminal": True}
async def tool(run, name, arguments, turn_id, event_id):
    await asyncio.sleep(0.05)
    return {"result": {"content": words(20000, tool_rng)}}
agent._provider_response = provider
agent.execute_tool = tool
server.auth.server_requires_auth = lambda: False
recall.start_message_indexing()
import uvicorn
# Mirror the tree's own CLI launch settings (the original tree used uvicorn's default).
ws_max = 16 * 1024 * 1024
try:
    from vulcan import cli
    if hasattr(cli, "_UVICORN_WS_ARGS"): ws_max = int(cli._UVICORN_WS_ARGS[1])
except Exception: pass
uvicorn.run(server.app, host="127.0.0.1", port=int(sys.argv[2]), log_level="warning", ws_max_size=ws_max)
