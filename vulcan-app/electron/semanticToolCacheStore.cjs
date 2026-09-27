const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const CHANNELS = {
  read: 'vulcan-semantic-tool-cache-read',
  write: 'vulcan-semantic-tool-cache-write',
  remove: 'vulcan-semantic-tool-cache-remove',
};

function normalizeEndpoint(value) {
  try {
    const url = new URL(String(value || 'http://localhost:8468'));
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || 'http://localhost:8468').replace(/\/$/, '');
  }
}

function cacheFilename(directory, endpoint) {
  const key = crypto.createHash('sha256').update(normalizeEndpoint(endpoint), 'utf8').digest('hex');
  return path.join(directory, `${key}.json`);
}

function createSemanticToolCacheStore({ userDataPath }) {
  const directory = path.join(userDataPath, 'semantic-tool-cache');
  const mutations = new Map();

  function serialize(endpoint, operation) {
    const key = normalizeEndpoint(endpoint);
    const previous = mutations.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    mutations.set(key, next.catch(() => {}));
    return next;
  }

  async function read(endpoint) {
    const filename = cacheFilename(directory, endpoint);
    try {
      return JSON.parse(await fsp.readFile(filename, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      // Corrupt/truncated caches are disposable derived state. Quarantine the
      // bytes and let the renderer rebuild them from the authoritative Etna catalog.
      try {
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        await fsp.rename(filename, `${filename}.corrupt-${Date.now()}`);
      } catch { /* best effort */ }
      return null;
    }
  }

  async function write(endpoint, value) {
    return serialize(endpoint, async () => {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = cacheFilename(directory, endpoint);
      const tmp = path.join(directory, `.${path.basename(filename)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      let handle = null;
      try {
        handle = await fsp.open(tmp, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(value), 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await fsp.rename(tmp, filename);
        try { await fsp.chmod(filename, 0o600); } catch { /* Windows ACLs own access control. */ }
        return { ok: true };
      } finally {
        if (handle !== null) { try { await handle.close(); } catch { /* best effort */ } }
        try { await fsp.rm(tmp, { force: true }); } catch { /* best effort */ }
      }
    });
  }

  async function remove(endpoint) {
    return serialize(endpoint, async () => {
      try { await fsp.rm(cacheFilename(directory, endpoint), { force: true }); } catch { /* best effort */ }
      return { ok: true };
    });
  }

  return { read, write, remove, directory };
}

function registerSemanticToolCacheIpc({ ipcMain, store }) {
  ipcMain.handle(CHANNELS.read, async (_event, endpoint) => store.read(endpoint));
  ipcMain.handle(CHANNELS.write, async (_event, endpoint, value) => store.write(endpoint, value));
  ipcMain.handle(CHANNELS.remove, async (_event, endpoint) => store.remove(endpoint));
}

module.exports = { CHANNELS, createSemanticToolCacheStore, registerSemanticToolCacheIpc, normalizeEndpoint };
