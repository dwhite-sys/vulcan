const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const CHANNELS = {
  status: 'vulcan-server-password-status',
  get: 'vulcan-server-password-get',
  set: 'vulcan-server-password-set',
  remove: 'vulcan-server-password-remove',
};

function normalizeEndpoint(endpoint) {
  const parsed = new URL(String(endpoint || '').trim());
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Server passwords require an HTTP or HTTPS endpoint');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Server password endpoints cannot contain credentials, paths, queries, or fragments');
  }
  return parsed.origin;
}

function createSecurePasswordStore({ safeStorage, userDataPath, platform = process.platform }) {
  const filename = path.join(userDataPath, 'vulcan-server-passwords.encrypted.json');
  let mutation = Promise.resolve();

  async function isAvailable() {
    try {
      if (platform === 'linux') {
        if (typeof safeStorage.getSelectedStorageBackend !== 'function') return false;
        const backend = safeStorage.getSelectedStorageBackend();
        if (!backend || backend === 'basic_text' || backend === 'unknown') return false;
      }
      if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
        return Boolean(await safeStorage.isAsyncEncryptionAvailable());
      }
      return typeof safeStorage.isEncryptionAvailable === 'function'
        && Boolean(safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  function readEntries() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.assign(Object.create(null), parsed)
        : Object.create(null);
    } catch {
      return Object.create(null);
    }
  }

  function writeEntries(entries) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* Windows ACLs own access control. */ }
    fs.renameSync(temporary, filename);
  }

  function serialize(operation) {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => {});
    return next;
  }

  async function ensureAvailable() {
    if (!await isAvailable()) throw new Error('Secure operating-system credential storage is unavailable');
  }

  async function set(endpoint, password) {
    const key = normalizeEndpoint(endpoint);
    if (typeof password !== 'string' || !password) throw new Error('A nonempty server password is required');
    await ensureAvailable();
    return serialize(async () => {
      const encrypted = typeof safeStorage.encryptStringAsync === 'function'
        ? await safeStorage.encryptStringAsync(password)
        : safeStorage.encryptString(password);
      const entries = readEntries();
      entries[key] = Buffer.from(encrypted).toString('base64');
      writeEntries(entries);
      return { ok: true };
    });
  }

  async function remove(endpoint) {
    const key = normalizeEndpoint(endpoint);
    return serialize(async () => {
      const entries = readEntries();
      if (Object.hasOwn(entries, key)) {
        delete entries[key];
        writeEntries(entries);
      }
      return { ok: true };
    });
  }

  async function get(endpoint) {
    const key = normalizeEndpoint(endpoint);
    if (!await isAvailable()) return null;
    await mutation;
    const encrypted = readEntries()[key];
    if (typeof encrypted !== 'string' || !encrypted) return null;
    try {
      const bytes = Buffer.from(encrypted, 'base64');
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const decrypted = await safeStorage.decryptStringAsync(bytes);
        const password = typeof decrypted === 'string' ? decrypted : decrypted?.result;
        if (typeof password !== 'string' || !password) return null;
        if (decrypted?.shouldReEncrypt) await set(key, password);
        return password;
      }
      const password = safeStorage.decryptString(bytes);
      return typeof password === 'string' && password ? password : null;
    } catch {
      await remove(key);
      return null;
    }
  }

  return { isAvailable, get, set, remove };
}

function isTrustedRenderer(event, { isDev, indexPath }) {
  const frame = event?.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const rendererUrl = new URL(frame.url);
    if (isDev) return rendererUrl.origin === 'http://localhost:5173';
    return rendererUrl.protocol === 'file:'
      && path.resolve(fileURLToPath(rendererUrl)) === path.resolve(indexPath);
  } catch {
    return false;
  }
}

function registerSecurePasswordIpc({ ipcMain, store, isDev, indexPath }) {
  function guard(event) {
    if (!isTrustedRenderer(event, { isDev, indexPath })) {
      throw new Error('Untrusted renderer cannot access remembered server passwords');
    }
  }

  ipcMain.handle(CHANNELS.status, async (event) => {
    guard(event);
    return { available: await store.isAvailable() };
  });
  ipcMain.handle(CHANNELS.get, async (event, endpoint) => {
    guard(event);
    return { password: await store.get(endpoint) };
  });
  ipcMain.handle(CHANNELS.set, async (event, endpoint, password) => {
    guard(event);
    return store.set(endpoint, password);
  });
  ipcMain.handle(CHANNELS.remove, async (event, endpoint) => {
    guard(event);
    return store.remove(endpoint);
  });
}

module.exports = { CHANNELS, createSecurePasswordStore, isTrustedRenderer, normalizeEndpoint, registerSecurePasswordIpc };
