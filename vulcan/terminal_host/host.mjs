import net from 'node:net';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Session, convertLegacy } from './session.mjs';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('An absolute private state directory is required');
await fs.mkdir(root, { recursive: true, mode: 0o700 });
await fs.chmod(root, 0o700);
const socketPath = path.join(root, 'host.sock');
const sessions = new Map();
let persistence = Promise.resolve();
function persist(action) { const result = persistence.then(action); persistence = result.catch(() => {}); return result; }
const checkpointPath = key => path.join(root, createHash('sha256').update(key).digest('hex') + '.json');
async function checkpoint(key, session) {
  if (sessions.get(key) !== session) return;
  const snapshot = await session.snapshot(true);
  const target = checkpointPath(key);
  const temporary = target + '.tmp';
  const handle = await fs.open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify({ protocol: 1, key, ...snapshot })); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, target);
  const directory = await fs.open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function retireShell(launch, token) {
  if (!launch.retire || !token) return;
  const result = spawnSync(launch.retire.file, [...launch.retire.args, token], { encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  // A stopped/removed container has already retired all inner processes.
  if (result.status !== 0 && !/not running|No such container/.test(result.stderr || '')) throw new Error('Could not retire abandoned inner shell');
}
async function dispatchSession(message) {
  if (message.protocol !== 1) throw new Error('Incompatible terminal host protocol');
  const { method, key, params = {} } = message;
  if (method === 'convertLegacy') return convertLegacy(params.data, params.cols, params.rows);
  if (method === 'health') return { protocol: 1, pid: process.pid };
  if (typeof key !== 'string' || key.length > 512) throw new Error('Invalid session identity');
  let session = sessions.get(key);
  if (method === 'restoreInfo') {
    try { const state = JSON.parse(await fs.readFile(checkpointPath(key), 'utf8')); return { cwd: state.cwd, environment: state.environment }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
  }
  if (method === 'open') {
    if (!session || session.finished) {
      let restored;
      try { restored = JSON.parse(await fs.readFile(checkpointPath(key), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!restored && params.legacy) {
        await fs.writeFile(checkpointPath(key) + '.legacy-backup', params.legacy, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        restored = await convertLegacy(params.legacy, params.launch.cols, params.launch.rows);
      }
      if (restored) retireShell(params.launch, restored.launch?.nonce);
      if (restored) restored.commands = (restored.commands || []).map(command => ({ ...command, state: ['running', 'submitted'].includes(command.state) ? 'interrupted' : command.state }));
      session = new Session(params.launch, restored);
      sessions.set(key, session);
      await session.ready;
    }
    return session.snapshot();
  }
  if (!session && method === 'close') {
    let restored;
    try { restored = JSON.parse(await fs.readFile(checkpointPath(key), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (restored?.launch) retireShell(restored.launch, restored.launch.nonce);
    if (!params.retain) await persist(() => fs.unlink(checkpointPath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
    return true;
  }
  if (!session) throw new Error('Unknown terminal session');
  if (method === 'snapshot') return session.snapshot();
  if (method === 'state') return session.state();
  if (method === 'poll') return session.poll(params.sequence, params.generation);
  if (method === 'input') { await session.input(params.text); return true; }
  if (method === 'resize') { await session.resize(params.cols, params.rows); return true; }
  if (method === 'execute') return session.execute(params.id, params.command);
  if (method === 'command') {
    const snapshot = await session.snapshot();
    return snapshot.commands.find(command => command.id === params.id) || null;
  }
  if (method === 'close') {
    retireShell(session.launch, session.launch.nonce);
    await session.close();
    if (params.retain) await persist(() => checkpoint(key, session));
    else {
      sessions.delete(key);
      await persist(() => fs.unlink(checkpointPath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
    }
    sessions.delete(key);
    return true;
  }
  throw new Error('Unknown terminal host operation');
}
const operations = new Map();
function dispatch(message) {
  if (['health', 'convertLegacy'].includes(message.method)) return dispatchSession(message);
  const key = message.key;
  const prior = operations.get(key) || Promise.resolve();
  const result = prior.then(() => dispatchSession(message));
  const settled = result.catch(() => {});
  operations.set(key, settled);
  settled.finally(() => { if (operations.get(key) === settled) operations.delete(key); });
  return result;
}
const server = net.createServer(connection => {
  let buffer = '';
  let requests = Promise.resolve();
  connection.setEncoding('utf8');
  connection.on('error', () => {});
  connection.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) return connection.destroy();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      requests = requests.then(async () => {
        let message;
        try {
          message = JSON.parse(line);
          const result = await dispatch(message);
          connection.write(JSON.stringify({ id: message.id, result }) + '\n');
        } catch (error) { connection.write(JSON.stringify({ id: message?.id, error: error.message }) + '\n'); }
      }).catch(() => connection.destroy());
    }
  });
});
// Service restarts may inherit a stale socket. Probe it before removing it.
try {
  await fs.lstat(socketPath);
  const active = await new Promise(resolve => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => { probe.destroy(); resolve(false); });
    probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
  });
  if (active) throw new Error('A terminal host already owns this state directory');
  await fs.unlink(socketPath);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
await fs.chmod(socketPath, 0o600);
let checkpointing = false;
setInterval(async () => {
  if (checkpointing) return;
  checkpointing = true;
  try { for (const [key, session] of sessions) await persist(() => checkpoint(key, session)); }
  catch (error) { process.stderr.write(`Terminal checkpoint failed: ${error.message}\n`); }
  finally { checkpointing = false; }
}, 1000).unref();
// Backend/viewer disconnects deliberately have no session teardown callback.
// A clean service/PC shutdown checkpoints the latest state before process loss.
// Reopening revives a fresh shell and marks unfinished commands interrupted.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { for (const [key, session] of sessions) await persist(() => checkpoint(key, session)); }
  catch (error) { process.stderr.write(`Final terminal checkpoint failed: ${error.message}\n`); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
