# Traffic / concurrency architecture — implementation status

This maps the *Vulcan Traffic / Concurrency Architecture Overhaul* handoff onto
the code as implemented on this branch. The baseline was the supplied
`vulcan-main(2)` archive, which was byte-identical to `main` at `a189a8f`.

Governing rules, applied throughout:

- The asyncio event loop is the traffic cop, not one of the trucks.
- No amount of model output may make the Vulcan control plane unavailable.
- Do not optimize unnecessary work; make it stop running unless its inputs changed.

## Measured result

`vulcan/tests/test_control_plane_e2e.py` drives two real encrypted
`/ws/general` clients through the FastAPI app. Client A runs a provider that
emits tokens as fast as the loop allows. While that run is going, client B
connects and registers, and A queries status and presses Stop. The table shows
three runs per tree, in the same container:

| | original tree (`a189a8f`) | this branch |
|---|---|---|
| tokens produced in the same window | ~92k | ~370k–600k |
| second client `client/register` | 65–90 ms | 10–95 ms |
| `runs/status` during the flood | **960–1160 ms** | 2–210 ms |
| Stop → finalized ack | 220–265 ms | 240–295 ms (with 4–6× more text to finalize) |

The streamed transcript that client A reconstructs from deltas matches the
durable transcript exactly.

Persistence (`test_persistence_architecture.py`, measured directly):

| history size | one run checkpoint (new) | full save of the same chat |
|---|---|---|
| 100 events | ~0.9 ms | 18 ms |
| 1 000 events | ~0.9 ms | 79 ms |
| 4 000 events | ~1.4 ms | 295 ms |

Before this branch, every checkpoint was a full save (`DELETE` plus reinsert of
all rows and a per-chat FTS rebuild), with a whole-chat `deepcopy` on the loop.

## The field symptom, reproduced and fixed

The field report: after about 5 messages the whole server slows and freezes.
Clients can't connect, chats can't be opened, and opening a chat takes
forever. It clears after tens of minutes, then freezes again as soon as you
speak in that chat.

`vulcan/tests/soak/` reproduces it out-of-process: a real uvicorn server,
separate client processes over TCP, a 100-chat corpus, and a single chat that
receives message after message. Each message is an agentic turn: streamed
reasoning, four tool calls returning ~150 KB each, and a streamed answer. The
first message carries an image, and the post-message indexing/tagging
pipeline is live. A second client keeps connecting, listing chats and
re-opening that chat.

| | original tree | this branch |
|---|---|---|
| message 1 | run 1.0 s | run 2.0 s (startup work still running) |
| message 2 | second client completed **0** probes | run 1.2 s, worst navigation 0.17 s |
| message 3 | `runs/start` ack **9.7 s**, run 10.8 s | ack 66 ms, run 1.1 s |
| message 4 | **`runs/start` not acknowledged within 60 s: frozen** | ack 16 ms, run 1.05 s |
| message 10 | — | ack 34 ms, run 1.6 s, worst navigation 0.67 s |
| message 20 (12.5 MB chat) | — | ack 35 ms, run 1.9 s, worst navigation 0.78 s |
| message 30 (18.6 MB chat) | — | ack 40 ms, run 1.7 s, worst navigation 1.6 s; 0 errors |

On this branch, run time stays flat. Opening a chat grows with the size of the
transcript it has to transfer. The in-process variant is
`test_chat_soak_e2e.py`.

Root causes, all fixed, each of which scales with chat size or corpus size:

1. **Every checkpoint rewrote the entire chat.** The rewrite ran after a
   whole-chat `deepcopy` on the loop, and each save also did a whole-corpus
   FTS scan (`DELETE ... WHERE chat_id` on an UNINDEXED column), all under
   the global DB lock. A tool loop checkpoints after every tool call.
2. **The post-message tagging and indexing path scanned the whole corpus.**
   `topics._records` and `recall.index_message` looked up `chat_search` rows
   by UNINDEXED columns, so tagging one chat after a message held the DB lock
   for ~3.3 s at 200 chats. Now 5 ms (keyed-rowid joins).
3. **Navigation queued behind all of the above.** Every read took the
   same writer lock. Reads now run in WAL snapshots on their own
   connections and executor.
4. **Every message re-uploaded and re-parsed the whole chat.** `runs/start`
   carried the entire conversation, and the old branch graph embedded every
   event a second time. `runs/start` now references server-held history.
5. **Large chats killed the connection.** uvicorn closes any WebSocket
   whose inbound frame exceeds 16 MiB. Past ~12 MB of chat, every full-chat
   upload dropped the whole control connection. The limit is raised
   (bounded), and uploads are small anyway.
6. **O(chat) work on the event loop.** History projection, provider body
   encoding and large frame encoding happened on the loop, or in single
   GIL-holding calls. They now run in workers, in GIL-releasing pieces.

## Status by handoff section

Legend: **done** = implemented and tested; **partial** = the core is done and
the remainder is noted; **deferred** = intentionally not in this change.

### Pass A — semantic hot path

| Item | Status | Where |
|---|---|---|
| 3.1 growing-string accumulation | **done** | `ProviderStreamParser` keeps chunk lists (content, reasoning, tool names/args). `AgentRun` keeps per-event `_EventStream` builders and joins only at boundaries (`materialize`). |
| 3.2 / A1 true run deltas | **done** | `push/run-delta {event_id, seq, append, extend, set}` carries a contiguous per-event `seq`. `push/run-event` snapshots carry `seq`, and full snapshots carry `seqs`. A flush timer ensures a quiet provider never strands received tokens. |
| A3 cheap client delta application | **done** | `services/runStream.ts`: queued per frame, one copy-on-write per batch, O(1) per delta. Seq bookkeeping is attached to the events-array identity, so React updaters stay pure. |
| 4.1 / A4 no branch rebuild per token | **done** | Deltas and event snapshots never call `syncCurrentBranch`; it runs only at full-snapshot/subscribe boundaries. `branchEvents` reads the live transcript for the current branch. |
| 4.2 / 4.3 / A5 one live transcript owner | **partial** | Tokens touch only the live transcript (active/pending chat). The sidebar list receives authoritative boundaries only, and gets the live copy back when the user switches away. `activeChat` and `pendingChat` are still two React states. |

### Pass B — traffic architecture

| Item | Status | Where |
|---|---|---|
| 3.3 / B1 bounded client relay | **done** | `services/clientHttpRelay.ts`: a server-granted byte window with credits, so the fetch reader *awaits* capacity. Credits come back in the sender's own units (`n`), so JS and Python string lengths cannot drift. Legacy servers get a bounded local backlog. |
| 3.4 / B2 bounded server relay | **done** | `etna_registry.RelayStream`: a byte-accounted backlog that grants credit on consumption, always returns the remainder once drained (no deadlock), and hard-caps clients that don't use credits. |
| 3.6 secure-frame work off the loop | **done** | `SecureWebSocketSession.send_plaintext` / `receive_json_sized` seal and open frames of 256 KiB or more in a worker. BULK responses from freshly built payloads are JSON-encoded off-loop. |
| 3.7 / B4 physical egress lanes | **done** | `vulcan/traffic.py` `EgressScheduler`: CONTROL first; then deficit round robin by bytes, weighted STATE 8 > STREAM 4 > BULK 1, each lane with its own byte budget. Ordered frames (STATE pushes, `runs/subscribe`) form a barrier that live deltas cannot overtake. A lagging STREAM subscriber degrades to one lazily built replacement snapshot per event. A runaway STATE backlog disconnects that client, which resyncs on reconnect. |
| 3.8 / B3 admission before task creation | **done** | `traffic.Admission`: `control` / `general` / `bulk` classes, each with its own active slots and a bounded waiting room that holds callables, not parked tasks. When full, the request is rejected with a `busy` error. |
| 12 Stop never waits behind its work | **done** | `runs/cancel` takes effect inside the receive loop; only the wait-for-finalization ack runs as a control task. Stop before the run's first step now finalizes correctly (previously the chat was left stranded as "running"). |
| 4.4 / B5 poll amplification | **done** | Terminal-status, topic and Settings probes are single-flight. Topics are versioned (`since_version` → `unchanged`) and pushed (`push/topics-changed`); the timer is only a 30 s reconciliation. |
| Delta traffic only where it is looked at | **done** | Sessions receive token deltas only for their focused chat; background chats get boundaries only. |
| 3.5 / B6 dedicated provider/data channel | **deferred** | The handoff says to do this only after B1/B2 are demonstrably stable in real use. Relay chunks are already handled inline and in order, and credits/cancel ride the CONTROL lane. A separate authenticated socket is the next step once the credit window has field data. |

### Pass C — persistence and state

| Item | Status | Where |
|---|---|---|
| 5.1 / C1 incremental event persistence | **done** | `chats.RunCheckpoint` + `apply_run_checkpoint`: history before `persist_base` is never rewritten, and only changed tail payloads are sent. On divergence it falls back to a full, verified save. `save_chat` is diff-based. |
| 5.4 / C2 incremental search projections | **done** | FTS rows use stable keyed rowids (`fts_rowids`), so per-event maintenance is O(log n) instead of an FTS scan per save. Very large events are committed first and indexed immediately afterwards (latest-wins, order-independent). |
| 5.2 / 5.7 / C3 reference branch topology + migration | **done** | Stored nodes are `{eventId, parentId}`; off-path payloads are canonical in `branch_events`. Legacy embedded graphs are read transparently and migrated lazily, only after every reference is verified. Old renderers still receive the embedded form; new ones request `branch_refs` and send compact graphs (`branch-refs-v1`). |
| 5.5 / C4 no giant deepcopy on the loop | **done** | Checkpoints are built from strings and tuples on the loop; the initial persist uses a shallow snapshot. |
| 6 / C5 deliberate DB executor | **done** | Writes go through `chats.run_db` (a dedicated 2-thread writer executor, serialized by the writer lock). Reads go through `run_db_read` (their own executor, lock-free WAL snapshots). Connections are cached per thread, and schema checks are keyed on SQLite's schema cookie. |
| 5.6 durability boundaries | **done** | Per-run checkpoints stay ordered by `persistence_lock`; the question and final boundaries are awaited. A failed checkpoint re-marks its events dirty. |
| 7 / C6 metadata-sized sidebar | **done** | The `chats.summary_json` column (lazily backfilled) means `chats/list(summary_only)` never parses metadata. |
| 8 / C7 one chat-open transaction, one reconnect owner | **done** | Opening a summary-only chat is a single `runs/subscribe {include_chat, branch_refs}` carrying the transcript, seqs, status and question. Reconnect is owned only by `push/connected`; the old effect that re-subscribed whenever *Etna* health changed is gone. |
| Summary-only upsert data loss | **fixed** | Previously, dragging an un-hydrated chat into a folder sent `events: []` and wiped the transcript. Such upserts are now metadata-only. |
| 9 / C8 slim `runs/start` | **done (chat)** | `runs/start` sends `chat_ref {base_len, base_last_id, new_events}` and the server rebuilds the chat from stored history; the initial persist becomes a mutation. Divergence returns `stale_base`, and the renderer falls back to a full upload (`runs-start-ref-v1`). The tool universe/settings are still sent each turn; they are small next to a transcript. |

### Pass D — instrumentation

| Item | Status | Where |
|---|---|---|
| D1 instrumentation | **partial** | The `server/metrics` RPC reports event-loop lag, per-lane queued/peak/sent bytes, stream resyncs, admission load/rejections, relay backlog, run stream counts, and DB queue and latency. Client-side decode/dispatch timing is not yet collected. |
| D2 Web Worker decode | **deferred** | As the handoff directs: measure first, now that deltas and lanes exist. |
| D3 budget tuning | **initial values** | STREAM 512 KiB, STATE soft 4 MiB / hard 64 MiB, BULK soft 8 MiB, relay window 256 KiB. All live in `EgressBudgets` / `RELAY_WINDOW_BYTES`. |

## Protocol and compatibility

All additions are negotiated, so mixed old and new clients and servers keep working:

- Clients announce `capabilities` in `client/register`, `runs/start` and
  `runs/subscribe` (`run-delta-v1`, `branch-refs-v1`, `relay-credit-v1`).
  Servers answer `client/register` with their own list (plus
  `subscribe-include-chat-v1`, `topics-push-v1`).
- Without `run-delta-v1`, a renderer receives coalesced event snapshots, as before.
- Without `branch-refs-v1` on the server, the renderer keeps sending embedded
  branch graphs. The server accepts both forms from any client.
- `flow.window_bytes` in `push/client-http-request` enables credits. Clients
  that ignore it are bounded by the server's hard cap.

## Tests

- Python: `test_traffic_architecture.py` (parser, delta protocol, lanes, ordering,
  admission, relay credits), `test_persistence_architecture.py` (mutation-sized
  writes, scaling, legacy migration fixture, summaries, summary-only guard,
  deferred indexing), `test_control_plane_e2e.py` (the table above).
- Renderer: `npm run test:run-stream`, `test:client-relay`,
  `test:provider-stream-relay`.

Not yet exercised: a packaged Electron build against a real provider, a real
client-POV provider at high tokens/sec, and multi-hour soak tests. CI covers the
build and packaging, and `server/metrics` is how to observe the new budgets in
the field.
