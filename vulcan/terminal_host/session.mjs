import headless from '@xterm/headless';
const { Terminal } = headless;
import serialization from '@xterm/addon-serialize';
const { SerializeAddon } = serialization;
import pty from 'node-pty';
import { randomUUID } from 'node:crypto';

const validSize = (cols, rows) => Number.isInteger(cols) && cols >= 2 && cols <= 1000 && Number.isInteger(rows) && rows >= 1 && rows <= 500;
// Adapted from VS Code's MIT-licensed deserializeVSCodeOscMessage at the pinned revision.
export const decode = value => value.replaceAll(/\\(\\|x([0-9a-f]{2}))/gi, (_match, op, hex) => hex ? String.fromCharCode(parseInt(hex, 16)) : op);

function renderedText(buffer, first = 0, last = buffer.length - 1) {
  const lines = [];
  for (let i = first; i <= last; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').replace(/\n+$/, '');
}

/** One authority for PTY geometry, terminal reports, output and shell state.
 * OSC 633 boundaries follow VS Code's shellIntegrationAddon and command detection
 * capability; prompt and command text are not used to guess completion.
 */
export class Session {
  constructor(launch, restored) {
    if (!validSize(launch.cols, launch.rows)) throw new Error('Invalid terminal dimensions');
    this.launch = launch;
    this.generation = randomUUID();
    this.sequence = 0;
    this.events = [];
    this.commands = new Map((restored?.commands || []).map(command => [command.id, command]));
    this.busy = false;
    this.integration = 'pending';
    this.finished = false;
    this.cwd = restored?.cwd || launch.cwd;
    this.environment = restored?.environment || {};
    this.queue = Promise.resolve();
    this.term = new Terminal({ cols: restored?.cols || launch.cols, rows: restored?.rows || launch.rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.parser.registerOscHandler(633, value => this.shellEvent(value));
    // Only this emulator answers live device queries. Viewers and restore never do.
    this.term.onData(data => { if (!this.replaying && this.proc && !this.finished) this.proc.write(data); });
    const integrationTimer = setTimeout(() => { if (this.integration === 'pending') this.integration = 'degraded'; }, 10000);
    integrationTimer.unref();
    this.ready = this.enqueue(async () => {
      if (restored?.data) {
        this.replaying = true;
        await this.write(restored.data);
        this.replaying = false;
      }
      this.term.resize(launch.cols, launch.rows);
      this.proc = pty.spawn(launch.file, launch.args, { name: 'xterm-256color', cols: launch.cols, rows: launch.rows, cwd: launch.hostCwd, env: launch.env });
      this.pendingBytes = 0;
      this.proc.onData(data => {
        this.pendingBytes += Buffer.byteLength(data);
        if (this.pendingBytes > 256 * 1024 && !this.paused) { this.paused = true; this.proc.pause(); }
        this.enqueue(async () => {
        await this.write(data);
        this.events.push({ sequence: ++this.sequence, data });
        if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
        this.pendingBytes -= Buffer.byteLength(data);
        if (this.paused && this.pendingBytes < 64 * 1024 && !this.finished) { this.paused = false; this.proc.resume(); }
        });
      });
      this.proc.onExit(event => this.enqueue(async () => {
        this.finished = true;
        this.exitCode = event.exitCode;
        if (this.pending) { this.pending.state = 'interrupted'; this.pending.output = this.commandText(); this.pending = undefined; }
        this.busy = false;
      }));
    });
  }
  enqueue(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  write(data) { return new Promise(resolve => this.term.write(data, resolve)); }
  shellEvent(value) {
    if (this.replaying) return true;
    const [type, ...parts] = value.split(';');
    if (type === 'A') { this.integration = 'ready'; this.inputPending = false; }
    if (type === 'C') {
      this.busy = true;
      if (this.pending) { this.pending.state = 'running'; this.startMarker = this.term.registerMarker(0); }
    }
    if (type === 'D') {
      this.busy = false;
      if (this.pending && this.pending.state === 'running' && /^\d+$/.test(parts[0] || '')) {
        this.pending.output = this.commandText();
        this.pending.exitCode = Number(parts[0]);
        this.pending.state = 'completed';
        this.pending = undefined;
        this.startMarker?.dispose();
      }
    }
    if (type === 'P' && parts[0]?.startsWith('Cwd=')) this.cwd = decode(parts.join(';').slice(4));
    if (type === 'EnvSingleStart' && parts[0] === '1' && parts[1] === this.launch.nonce) this.environment = {};
    if (type === 'EnvSingleEntry' && parts.at(-1) === this.launch.nonce) this.environment[parts[0]] = decode(parts.slice(1, -1).join(';'));
    return true;
  }
  commandText() {
    const buffer = this.term.buffer.active;
    const first = this.startMarker && !this.startMarker.isDisposed ? this.startMarker.line : 0;
    return renderedText(buffer, first, buffer.baseY + buffer.cursorY);
  }
  async input(text) {
    await this.ready;
    return this.enqueue(() => {
      if (this.finished) throw new Error('Terminal exited');
      if (!this.busy && text) this.inputPending = true;
      this.proc.write(text);
    });
  }
  async execute(id, command) {
    await this.ready;
    return this.enqueue(() => {
      if (this.finished) throw new Error('Terminal exited');
      if (this.integration !== 'ready') throw new Error('Shell integration unavailable: command completion cannot be detected');
      if (this.busy || this.pending) throw new Error('Terminal is busy');
      if (this.inputPending) throw new Error('Terminal has pending user input; finish or cancel that input before submitting a tool command');
      const record = { id, command, state: 'submitted', output: '' };
      if (this.commands.size >= 128) this.commands.delete(this.commands.keys().next().value);
      this.commands.set(id, record);
      this.pending = record;
      this.proc.write(`{\n${command.replace(/\n+$/, '')}\n}\n`);
      return record;
    });
  }
  async resize(cols, rows) {
    if (!validSize(cols, rows)) throw new Error('Invalid terminal dimensions');
    await this.ready;
    return this.enqueue(() => {
      if (this.term.cols === cols && this.term.rows === rows) return;
      this.term.resize(cols, rows);
      if (!this.finished) this.proc.resize(cols, rows);
      this.events.push({ sequence: ++this.sequence, cols, rows });
    });
  }
  async state() {
    await this.ready;
    return this.enqueue(() => ({ generation: this.generation, sequence: this.sequence, cols: this.term.cols, rows: this.term.rows, busy: this.busy, integration: this.integration, finished: this.finished, commands: [...this.commands.values()].map(record => ({ ...record, output: record === this.pending && record.state === 'running' ? this.commandText() : record.output })) }));
  }
  snapshotNow(durable = false) {
    return { generation: this.generation, sequence: this.sequence, cols: this.term.cols, rows: this.term.rows,
      text: renderedText(this.term.buffer.active), data: this.serializer.serialize({ excludeAltBuffer: durable, excludeModes: durable }),
      cwd: this.cwd, environment: this.environment, launch: this.launch, busy: this.busy, integration: this.integration, finished: this.finished,
      commands: [...this.commands.values()].map(record => ({ ...record, output: record === this.pending && record.state === 'running' ? this.commandText() : record.output })) };
  }
  async snapshot(durable = false) {
    await this.ready;
    return this.enqueue(() => this.snapshotNow(durable));
  }
  async poll(sequence, generation) {
    await this.ready;
    return this.enqueue(() => {
      if (generation !== this.generation || sequence < (this.events[0]?.sequence || 1) - 1 || sequence > this.sequence) return { snapshot: this.snapshotNow() };
      return { events: this.events.filter(event => event.sequence > sequence), sequence: this.sequence, busy: this.busy, integration: this.integration, finished: this.finished };
    });
  }
  async close() { await this.ready; return this.enqueue(() => { if (!this.finished) this.proc.kill(); this.finished = true; this.busy = false; if (this.pending) { this.pending.output = this.commandText(); this.pending.state = 'interrupted'; this.pending = undefined; } }); }
}

/** Legacy data is parsed in an isolated emulator with no input callbacks. */
export async function convertLegacy(data, cols = 80, rows = 24) {
  const terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  await new Promise(resolve => terminal.write(data, resolve));
  const result = serializer.serialize({ excludeAltBuffer: true, excludeModes: true });
  const text = renderedText(terminal.buffer.normal);
  terminal.dispose();
  return { data: result, text: text, cols, rows };
}
