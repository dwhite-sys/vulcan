import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import {
  getServerCredentialStore,
  normalizeCredentialEndpoint,
} from '../src/app/services/serverCredentialStore.ts';

const require = createRequire(import.meta.url);
const {
  CHANNELS,
  createSecurePasswordStore,
  isTrustedRenderer,
  normalizeEndpoint,
  registerSecurePasswordIpc,
} = require('../electron/securePasswordStore.cjs');

const directory = mkdtempSync(join(tmpdir(), 'vulcan-secure-password-test-'));
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (password: string) => Buffer.from(`encrypted:${password}`),
  decryptStringAsync: async (encrypted: Buffer) => ({
    result: encrypted.toString().replace(/^encrypted:/, ''),
    shouldReEncrypt: false,
  }),
  getSelectedStorageBackend: () => 'gnome_libsecret',
};

assert.equal(normalizeEndpoint('ws://EXAMPLE.com:8468/'), 'http://example.com:8468');
assert.equal(normalizeCredentialEndpoint('wss://EXAMPLE.com:9443/'), 'https://example.com:9443');
for (const endpoint of [
  'http://user:secret@example.com',
  'http://example.com/private',
  'http://example.com/?token=secret',
  'ftp://example.com',
]) {
  assert.throws(() => normalizeEndpoint(endpoint));
  assert.throws(() => normalizeCredentialEndpoint(endpoint));
}

const desktop = createSecurePasswordStore({ safeStorage, userDataPath: directory, platform: 'linux' });
assert.equal(await desktop.isAvailable(), true);
await Promise.all([
  desktop.set('ws://alpha.example:8468', 'alpha-secret'),
  desktop.set('https://beta.example:9443', 'beta-secret'),
]);
assert.equal(await desktop.get('http://alpha.example:8468'), 'alpha-secret');
assert.equal(await desktop.get('wss://beta.example:9443'), 'beta-secret');
assert.equal(await desktop.get('http://beta.example:9443'), null,
  'Different transport security scopes must not share credentials');
const encryptedFile = join(directory, 'vulcan-server-passwords.encrypted.json');
const persisted = readFileSync(encryptedFile, 'utf8');
assert.doesNotMatch(persisted, /alpha-secret|beta-secret/);
if (process.platform !== 'win32') assert.equal(statSync(encryptedFile).mode & 0o777, 0o600);
await desktop.remove('ws://alpha.example:8468');
assert.equal(await desktop.get('http://alpha.example:8468'), null);
assert.equal(await desktop.get('wss://beta.example:9443'), 'beta-secret');

const insecureLinux = createSecurePasswordStore({
  safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' },
  userDataPath: join(directory, 'unsafe'),
  platform: 'linux',
});
assert.equal(await insecureLinux.isAvailable(), false);
await assert.rejects(insecureLinux.set('http://example.com:8468', 'never-write-me'), /unavailable/);

const syncSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (password: string) => Buffer.from(`protected:${password}`),
  decryptString: (encrypted: Buffer) => encrypted.toString().replace(/^protected:/, ''),
};
const windows = createSecurePasswordStore({
  safeStorage: syncSafeStorage,
  userDataPath: join(directory, 'windows'),
  platform: 'win32',
});
await windows.set('http://windows.example:8468', 'dpapi-secret');
assert.equal(await windows.get('ws://windows.example:8468'), 'dpapi-secret');

const indexPath = '/app/dist/index.html';
const trustedDev = { senderFrame: { url: 'http://localhost:5173/', parent: null } };
const trustedProduction = { senderFrame: { url: 'file:///app/dist/index.html', parent: null } };
assert.equal(isTrustedRenderer(trustedDev, { isDev: true, indexPath }), true);
assert.equal(isTrustedRenderer(trustedProduction, { isDev: false, indexPath }), true);
assert.equal(isTrustedRenderer({ senderFrame: { url: 'https://evil.example/', parent: null } },
  { isDev: true, indexPath }), false);
assert.equal(isTrustedRenderer({ senderFrame: { url: 'file:///tmp/evil.html', parent: null } },
  { isDev: false, indexPath }), false);
assert.equal(isTrustedRenderer({ senderFrame: { url: 'http://localhost:5173/', parent: {} } },
  { isDev: true, indexPath }), false);

const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
registerSecurePasswordIpc({
  ipcMain: { handle: (channel: string, callback: (...args: any[]) => Promise<any>) => ipcHandlers.set(channel, callback) },
  store: desktop,
  isDev: true,
  indexPath,
});
assert.deepEqual(await ipcHandlers.get(CHANNELS.status)!(trustedDev), { available: true });
await assert.rejects(ipcHandlers.get(CHANNELS.get)!(
  { senderFrame: { url: 'https://evil.example/', parent: null } }, 'http://beta.example:9443',
), /Untrusted renderer/);

const electronEntries = new Map<string, string>();
const electronRuntime = {
  electronAPI: {
    serverPasswords: {
      status: async () => ({ available: true }),
      get: async (endpoint: string) => ({ password: electronEntries.get(endpoint) ?? null }),
      set: async (endpoint: string, password: string) => { electronEntries.set(endpoint, password); },
      remove: async (endpoint: string) => { electronEntries.delete(endpoint); },
    },
  },
};
const electronStore = getServerCredentialStore(electronRuntime)!;
assert.equal(await electronStore.isAvailable(), true);
await electronStore.set('ws://electron.example:8468', 'desktop-password');
assert.equal(await electronStore.get('http://electron.example:8468'), 'desktop-password');

const nativeEntries = new Map<string, string>();
const nativePlugin = {
  get: async ({ key }: { key: string }) => ({ value: nativeEntries.get(key) ?? null }),
  set: async ({ key, value }: { key: string; value: string }) => { nativeEntries.set(key, value); },
  remove: async ({ key }: { key: string }) => { nativeEntries.delete(key); },
};
const androidRuntime = {
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
    Plugins: { SecureStoragePlugin: nativePlugin },
  },
};
const androidStore = getServerCredentialStore(androidRuntime)!;
await androidStore.set('ws://android.example:8468', 'keystore-password');
assert.equal(await androidStore.get('http://android.example:8468'), 'keystore-password');
assert.equal(await androidStore.get('http://different.example:8468'), null);
assert.ok([...nativeEntries.keys()][0].startsWith('vulcan.server-password.'));
await androidStore.remove('http://android.example:8468');
assert.equal(await androidStore.get('http://android.example:8468'), null);
assert.equal(getServerCredentialStore({
  Capacitor: { ...androidRuntime.Capacitor, isNativePlatform: () => false },
}), null, 'A Capacitor web shim must never pretend browser storage is a secure Android Keystore');
assert.equal(getServerCredentialStore({
  Capacitor: { ...androidRuntime.Capacitor, Plugins: {} },
}), null, 'Android must not remember passwords until a native secure-storage plugin is installed');
assert.equal(getServerCredentialStore({ localStorage: {} }), null);

const promptContext = createContext({});
let activeStore: any = electronStore;
const promptSource = readFileSync(new URL('../src/app/services/serverPasswordPrompt.ts', import.meta.url), 'utf8');
const promptModule = new SourceTextModule(stripTypeScriptTypes(promptSource), { context: promptContext });
await promptModule.link((specifier) => {
  assert.equal(specifier, './serverCredentialStore');
  return new SyntheticModule(['getServerCredentialStore'], function () {
    this.setExport('getServerCredentialStore', () => activeStore);
  }, { context: promptContext });
});
await promptModule.evaluate();
const {
  confirmServerPassword,
  rejectServerPassword,
  requestServerPassword,
  setServerPasswordPromptHandler,
} = promptModule.namespace as any;

let prompts = 0;
let promptedDetails: any;
setServerPasswordPromptHandler(async (details: any) => {
  prompts += 1;
  promptedDetails = details;
  return { password: 'manually-entered', remember: true, remembered: false };
});
await electronStore.set('http://remembered.example:8468', 'remembered-password');
const remembered = await requestServerPassword({ endpoint: 'ws://remembered.example:8468' });
assert.equal(remembered.password, 'remembered-password');
assert.equal(remembered.remembered, true);
assert.equal(prompts, 0, 'A remembered password must skip the login dialog on later app boots');
await rejectServerPassword('ws://remembered.example:8468', remembered);
assert.equal(await electronStore.get('http://remembered.example:8468'), null);
const manual = await requestServerPassword({ endpoint: 'ws://remembered.example:8468', error: 'Invalid password' });
assert.equal(prompts, 1);
assert.equal(promptedDetails.canRemember, true);
assert.equal(await electronStore.get('http://remembered.example:8468'), null,
  'Opting in must not store anything until the server accepts the password');
await confirmServerPassword('ws://remembered.example:8468', manual);
assert.equal(await electronStore.get('http://remembered.example:8468'), 'manually-entered');

activeStore = null;
await requestServerPassword({ endpoint: 'ws://browser.example:8468' });
assert.equal(promptedDetails.canRemember, false,
  'A browser or unsupported native shell must not offer insecure password persistence');

const dialog = readFileSync(new URL('../src/app/components/ServerPasswordDialog.tsx', import.meta.url), 'utf8');
assert.match(dialog, /Remember password for this server/);
assert.match(dialog, /useState\(false\)/, 'Remembering must be an explicit opt-in');
assert.doesNotMatch(dialog, /localStorage|sessionStorage/);

console.log('Desktop encrypted credentials, Capacitor Android secure-storage adapters, endpoint isolation, Linux fail-closed behavior, trusted IPC, opt-in persistence, and password rotation verified.');
