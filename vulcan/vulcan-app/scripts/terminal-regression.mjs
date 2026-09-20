import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const terminal = readFileSync(new URL('../../vulcan/vulcan/terminal.py', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../src/app/components/TerminalSlotWidget.tsx', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../src/app/components/WorkspacePanel.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../../vulcan/vulcan/agent_runtime.py', import.meta.url), 'utf8');

const wsTerminal = readFileSync(new URL('../../vulcan/vulcan/ws_terminal.py', import.meta.url), 'utf8');
const docker = readFileSync(new URL('../../vulcan/vulcan/docker.py', import.meta.url), 'utf8');
const server = readFileSync(new URL('../../vulcan/vulcan/server.py', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('../../vulcan/vulcan/container_lifecycle.py', import.meta.url), 'utf8');
const wsGeneral = readFileSync(new URL('../../vulcan/vulcan/ws_general.py', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../../vulcan/vulcan/agent_assets/skills/terminal/SKILL.md', import.meta.url), 'utf8');
const schemas = JSON.parse(readFileSync(new URL('../../vulcan/vulcan/agent_assets/tool_schemas.json', import.meta.url), 'utf8'));
const terminalTools = Object.fromEntries(schemas.workspace.map((tool) => [tool.name, tool]));
const commandBody = terminal.split('def use_terminal_in_slot(')[1]?.split('\ndef get_command(')[0] ?? '';

assert.ok(commandBody, 'The focused-slot execution implementation must exist');
assert.match(commandBody, /os\.write\(ts\.master_fd, wrapped\.encode/,
  'Agent commands must run inside the actual visible terminal PTY');
assert.doesNotMatch(commandBody, /subprocess\.Popen|stdin\s*=\s*subprocess\.DEVNULL/,
  'Focused terminal commands must not create a noninteractive shadow docker exec');
assert.match(commandBody, /remains active in the interactive terminal/,
  'Timeouts must detach without killing interactive SSH or the persistent shell');
assert.match(terminal, /def _close_slot_fd\(/,
  'Concurrent PTY teardown must close each file descriptor exactly once');
assert.doesNotMatch(widget, /send\(\{\s*type:\s*['"]close['"]/,
  'Changing terminal viewers must never destroy the persistent shell');
assert.match(widget, /disableStdin:\s*false/,
  'Agent and user terminals must both accept direct private input');
assert.match(widget, /send\(\{ type: 'input', text: data \}\)/,
  'User keystrokes must travel directly through the encrypted PTY channel');
assert.match(widget, /pendingInput \+= data[\s\S]*ensureContainer\(chatId\)[\s\S]*await connect\(\)/,
  'Typing into a stopped/disconnected terminal must buffer input, restart the workspace, and reconnect');
assert.match(widget, /if \(pendingInput && ws\?\.connected\)[\s\S]*type: 'input', text: buffered/,
  'Buffered wake-up input must be delivered only after the replacement PTY reports connected');
assert.match(wsTerminal, /record_activity\(chat_id, "terminal-input"\)/,
  'Direct encrypted terminal input must refresh container activity');
assert.match(wsTerminal, /"code": "auth_stale"/,
  'Expired terminal capability must be reported as recoverable auth state');
assert.match(widget, /msg\.code === 'auth_stale'[\s\S]*ensureConnected\(\{ reconfirm: true \}\)/,
  'Terminal stale auth must reconfirm through the General WS and retry instead of surfacing the auth wall');
assert.match(lifecycle, /reasons\.append\("open-chat"\)/,
  'A live client viewing a chat must protect its running container from idle reaping');
assert.match(wsGeneral, /containers\/chat-presence/,
  'The general WebSocket must expose session-scoped open-chat presence');
assert.match(app, /setOpenChatPresence\(workspaceChatId\)/,
  'The renderer must keep server-side chat presence synchronized with the active persisted chat');
assert.match(widget, /wsRef\.current\?\.connected/,
  'Encrypted WebSockets expose connected, not native readyState');
assert.match(widget, /scheduleReconnect/,
  'Unexpected viewer disconnections should automatically reconnect');
assert.match(workspace, /activeTerminalSlot\?\.kind === s\.kind/,
  'Inactive live shells must keep their authoritative server-reported status');
assert.match(widget, /msg\.reason === 'inactivity' \? 'closed-inactivity'/,
  'Auto-closed terminals must retain their resumable inactivity status');
assert.match(app, /vulcan\.openSlot\(selected\.chatId, selected\.kind, selected\.slot\)/,
  'Selecting an expired terminal must resume the same numbered slot');
assert.match(terminal, /preferred_slot=slot/,
  'Agent commands should automatically reopen their own inactivity-closed PTYs');
assert.match(runtime, /_initial_terminal_result\(pid\)/,
  'Long-running commands must yield the agent turn after their immediately available output');
assert.match(runtime, /"running": True, "slot": slot, "pid": pid/,
  'Active command results must expose process identity and terminal slot');
assert.match(runtime, /if "slot" in arguments:[\s\S]*_wait_for_terminal_slot/,
  'The existing wait tool must support conditional terminal completion');
assert.match(runtime, /name not in \("read_output", "send_input", "wait"\)/,
  'Repeated interactive navigation keys must not be mistaken for no-progress tool loops');
assert.match(terminal, /def encode_terminal_key\(/,
  'Semantic keyboard actions must translate to real PTY input');
assert.deepEqual(terminalTools.wait.parameters.required, ['seconds'],
  'Waiting must require an explicit timeout');
assert.ok(terminalTools.wait.parameters.properties.slot,
  'Waiting should accept an optional terminal slot');
assert.ok(terminalTools.send_input.parameters.properties.key,
  'Interactive input must support named keys');
assert.ok(terminalTools.send_input.parameters.properties.modifiers,
  'Interactive input must support semantic key modifiers');
assert.doesNotMatch(JSON.stringify(terminalTools.wait), /3600/,
  'The runtime timeout ceiling must not become standing model-visible policy');
assert.doesNotMatch(skill, /Slot 1 opens automatically/,
  'The terminal skill must not claim terminal allocation occurs implicitly');
assert.match(skill, /use `open_terminal`, then `switch_terminal`/,
  'The intentional allocate-focus-execute resource lifecycle must remain explicit');

assert.match(workspace, /key=\{`\$\{chatId\}-\$\{activeTerminalSlot\.kind\}-\$\{activeTerminalSlot\.slot\}/,
  'Chat identity must be part of the xterm React identity');
assert.match(widget, /xtermRef\.current\?\.reset\(\)/,
  'Reconnect must hard-reset xterm before applying the authoritative server snapshot');
assert.doesNotMatch(widget, /getSlotScrollback\(/,
  'The renderer must not independently hydrate terminal scrollback');
assert.doesNotMatch(widget, /saveSlotScrollback\(/,
  'The renderer must not persist scrollback under mutable chat identity');
assert.match(wsTerminal, /snapshot = \(term\.get_slot_scrollback[\s\S]*?\+ ""\.join\(current_chunks\)/,
  'The terminal WebSocket must send one coherent server-owned snapshot');
assert.match(wsTerminal, /sent_chunks = len\(current_chunks\)/,
  'Live streaming must start after the snapshot cursor instead of replaying chunk zero');
assert.doesNotMatch(terminal, /pkill -WINCH bash/,
  'Resize must be scoped to the PTY and never signal every bash in the chat container');
assert.match(docker, /def terminal_home\(kind: str, slot: int\)/,
  'Each logical slot must have an isolated HOME');
assert.match(docker, /--hostname", "vulcan"/,
  'Chat containers should have a stable Vulcan hostname instead of inheriting the host name');
assert.match(terminal, /prompt_identity = f"\{chat_id\}@vulcan"/,
  'Visible terminal identity should be chatid@vulcan');
assert.match(terminal, /VULCAN_SESSION=\{chat_id\}:\{kind\}:\{slot\}/,
  'The diagnostic session marker must identify chat, kind, and slot');
assert.match(server, /reconcile_orphan_terminal_processes/,
  'Server startup must reap docker-exec PTYs it can no longer reattach to');


assert.match(widget, /fitAddonRef\.current\?\.fit\(\)/,
  'The terminal must fit before opening a PTY connection');
assert.match(widget, /type: 'open'[\s\S]*cols: term\?\.cols \?\? 80[\s\S]*rows: term\?\.rows \?\? 24/,
  'The terminal open handshake must carry authoritative visible geometry');
assert.doesNotMatch(widget, /send\(\{ type: 'open'[\s\S]{0,300}type: 'resize'/,
  'Snapshot replay must not race a resize sent after open');
assert.match(wsTerminal, /cols = max\(1, int\(msg\.get\("cols", 80\)\)\)/,
  'The terminal server must consume geometry from the open handshake');
assert.match(wsTerminal, /term\.open_slot, chat_id, kind, slot, cols=cols, rows=rows/,
  'New PTYs must be created at the client geometry');
assert.match(wsTerminal, /term\.resize_slot\(chat_id, kind, slot, cols, rows\)[\s\S]*server is the sole transcript authority/i,
  'Existing PTYs must be resized before the authoritative snapshot is captured');

console.log('Terminal chat isolation, server-owned replay, per-slot HOME, scoped resize, orphan cleanup, chatid@vulcan identity, and existing interactive PTY behavior verified.');
