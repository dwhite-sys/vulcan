import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadVulcanServerProfiles,
  normalizeVulcanServerUrl,
  saveVulcanServerProfiles,
} from '../src/app/services/serverProfiles.ts';
import { isLoopbackVulcanServerUrl, transitionVulcanServer, withServerSwitchProbeDeadline } from '../src/app/services/serverSwitch.ts';

const entries = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
  removeItem: (key: string) => { entries.delete(key); },
};

assert.equal(normalizeVulcanServerUrl(' http://localhost:8468/ '), 'http://localhost:8468');
assert.equal(normalizeVulcanServerUrl('HTTPS://Example.COM:9443/'), 'https://example.com:9443');
assert.throws(() => normalizeVulcanServerUrl('ftp://example.com'), /HTTP or HTTPS/);
assert.throws(() => normalizeVulcanServerUrl('http://user:secret@example.com'), /passwords cannot be stored/);
assert.throws(() => normalizeVulcanServerUrl('http://example.com/?token=secret'), /query or fragment/);
assert.equal(isLoopbackVulcanServerUrl('http://localhost:8468'), true);
assert.equal(isLoopbackVulcanServerUrl('http://127.0.0.1:8468'), true);
assert.equal(isLoopbackVulcanServerUrl('http://127.1.2.3:8468'), true);
assert.equal(isLoopbackVulcanServerUrl('http://[::1]:8468'), true);
assert.equal(isLoopbackVulcanServerUrl('http://100.124.49.123:8468'), false);
assert.equal(isLoopbackVulcanServerUrl('http://192.168.50.10:8468'), false);
assert.equal(isLoopbackVulcanServerUrl('http://vulcan.example:8468'), false);

let profiles = loadVulcanServerProfiles();
assert.deepEqual(profiles, [{ id: 'vulcan-server-default', name: 'Local', url: 'http://localhost:8468' }]);
assert.equal(saveVulcanServerProfiles([
  ...profiles,
  { id: 'elite', name: '  EliteDesk  ', url: 'http://192.168.50.10:8468/' },
]), true);
profiles = loadVulcanServerProfiles();
assert.deepEqual(profiles[1], { id: 'elite', name: 'EliteDesk', url: 'http://192.168.50.10:8468' });
assert.equal(saveVulcanServerProfiles([{ id: 'unsafe', name: 'Unsafe', url: 'http://user:secret@example.com' }]), false);
assert.ok(!entries.get('vulcan:server_profiles')?.includes('secret'));

let calls: string[] = [];
let connected = 'old';
const createAdapter = () => ({
  previousUrl: 'old',
  targetUrl: 'new',
  probe: async (url: string) => { calls.push(`probe:${url}`); },
  flush: async () => { calls.push('flush'); },
  detach: () => { calls.push('detach'); },
  connect: (url: string) => { connected = url; calls.push(`connect:${url}`); },
  hydrate: async () => { calls.push(`hydrate:${connected}`); return `${connected}-context`; },
  commit: (url: string, context: string) => { calls.push(`commit:${url}:${context}`); },
});

await transitionVulcanServer(createAdapter());
assert.deepEqual(calls, [
  'probe:new', 'flush', 'detach', 'connect:new', 'hydrate:new', 'commit:new:new-context',
]);

calls = [];
connected = 'old';
const failingTarget = createAdapter();
failingTarget.hydrate = async () => {
  calls.push(`hydrate:${connected}`);
  if (connected === 'new') throw new Error('authentication cancelled');
  return `${connected}-context`;
};
await assert.rejects(transitionVulcanServer(failingTarget), /authentication cancelled/);
assert.deepEqual(calls, [
  'probe:new', 'flush', 'detach', 'connect:new', 'hydrate:new',
  'connect:old', 'hydrate:old', 'commit:old:old-context',
]);

calls = [];
const unreachable = createAdapter();
unreachable.probe = async () => { calls.push('probe:new'); throw new Error('offline'); };
await assert.rejects(transitionVulcanServer(unreachable), /offline/);
assert.deepEqual(calls, ['probe:new'], 'An offline target must not disturb the current server');

calls = [];
let deadlineSignalWasAborted = false;
const timedOut = createAdapter();
timedOut.probe = async (url: string) => {
  calls.push('probe:new');
  await withServerSwitchProbeDeadline(url, (signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      deadlineSignalWasAborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }), 25);
};
const timeoutStarted = Date.now();
await assert.rejects(transitionVulcanServer(timedOut), /Timed out checking new after 0\.0 seconds/);
assert.ok(Date.now() - timeoutStarted < 500, "The switch probe should use Vulcan's deadline, not an OS/network timeout");
assert.equal(deadlineSignalWasAborted, true, 'The deadline must abort in-flight network work');
assert.deepEqual(calls, ['probe:new'], 'A timed-out target must not flush or detach the current server');

calls = [];
const remoteWithoutPassword = createAdapter();
remoteWithoutPassword.probe = async () => {
  calls.push('probe:new');
  throw new Error('Remote Vulcan servers require a server password. Run vulcan set-password on the selected server, then switch again.');
};
await assert.rejects(transitionVulcanServer(remoteWithoutPassword), /vulcan set-password/);
assert.deepEqual(calls, ['probe:new'], 'An inaccessible remote target must leave the active server and its context untouched');

calls = [];
const same = { ...createAdapter(), targetUrl: 'old' };
await transitionVulcanServer(same);
assert.deepEqual(calls, [], 'Switching to the already-active server is a no-op');

const settings = readFileSync(new URL('../src/app/components/SettingsDialog.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const terminal = readFileSync(new URL('../src/app/components/TerminalSlotWidget.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/app/components/KitSidebar.tsx', import.meta.url), 'utf8');
const topBar = readFileSync(new URL('../src/app/components/TopBar.tsx', import.meta.url), 'utf8');
const transport = readFileSync(new URL('../src/app/services/ws.ts', import.meta.url), 'utf8');

assert.match(settings, />Vulcan Servers</);
assert.match(settings, /Saving a server does not change your current connection/);
assert.match(settings, /onClick=\{\(\) => void switchVulcanServer\(server\)\}/);
assert.match(settings, />ACTIVE</);
assert.doesNotMatch(settings, />Active Server</, 'The saved-server list already identifies the active server');
assert.match(app, /window\.dispatchEvent\(new CustomEvent\('vulcan:server-switching'\)\)/);
assert.match(app, /withServerSwitchProbeDeadline\(url, async \(signal\) =>/,
  'Reachability probing must use a bounded pre-detach deadline');
assert.match(app, /fetch\(`\$\{url\}\/ping`, \{ signal \}\)/,
  'The ping probe must be abortable by the shared server-switch deadline');
assert.match(app, /fetch\(`\$\{url\}\/auth\/status`, \{ signal \}\)/,
  'A public ping is insufficient: probe the remote server authentication boundary under the same deadline');
assert.match(app, /Promise\.all\(\[/,
  'Independent preflight requests should run concurrently instead of adding round trips');
assert.match(app, /remote_access_allowed/,
  'New servers must report whether the current client can open their protected WebSockets');
assert.match(app, /vulcan set-password/,
  'Password-free remote servers need an actionable setup instruction');
assert.doesNotMatch(app, /vulcan\.generalWS\.send\('providers\/list'/);
assert.doesNotMatch(app, /vulcan\.generalWS\.send\('providers\/current'/);
assert.match(app, /Provider and Etna definitions are client-owned/);
assert.match(app, /setActiveVulcanEndpoint\(url\);[\s\S]*?handleNewChat\(\);[\s\S]*?void testInferenceConnection\(\);/,
  'A successful server switch must initialize the same pending new-chat state as the New Chat button');
assert.match(app, /autoGenerateTitle: isPending/,
  'Only a brand-new server-owned conversation should request an automatic title');
assert.match(app, /title: isPending \? 'New Chat' : currentChat\.title \|\| 'New Chat'/,
  'New chats should start with the stable New Chat placeholder until the first response completes');
assert.match(sidebar, /titleStreaming \? 'shimmer' : ''/,
  'Generated chat names should use the existing active-step shimmer');
assert.match(sidebar, /setDisplayTitle\(next\.slice\(0, visible\)\)/,
  'The generated title should reveal progressively rather than popping in');
assert.match(app, /const serverChat = response\.chat as Chat;[\s\S]*?\.\.\.serverChat/,
  'The sidebar must initialize from the authoritative server chat snapshot');
assert.match(app, /onPush\('push\/chat-updated'/,
  'Server-classified chat titles must reach the live sidebar');
assert.match(app, /vulcan\.generalWS\.onConnectionChange\(\(connected\) => \{[\s\S]*?setVulcanConnected\(connected\)/,
  'Vulcan status must observe its authenticated transport, not Etna health');
assert.match(topBar, /aria-label=\{vulcanConnected \? 'Vulcan connected' : 'Vulcan not connected'\}/);
assert.match(topBar, /Vulcan connected: \$\{activeVulcanEndpoint\}/);
assert.ok(topBar.indexOf("aria-label={vulcanConnected ? 'Vulcan connected'") < topBar.indexOf('{/* Sidebar collapse toggle */}'),
  'The Vulcan connection indicator belongs beside the brand, before the sidebar toggle');
assert.match(terminal, /serverSwitchingRef\.current = true;/);
assert.doesNotMatch(terminal, /saveSlotScrollback\(/,
  'Terminal viewers must not write renderer-owned scrollback during server switches');
assert.doesNotMatch(terminal, /ws\.send\(\{\s*type:\s*['"]close['"]/,
  'Changing terminal viewers must detach without killing the running PTY');
assert.match(terminal, /wsRef\.current\?\.connected/,
  'Terminal resize must use the encrypted transport connected state');
assert.match(terminal, /send\(\{ type: 'resize', cols, rows \}\)/,
  'Terminal resize must send an object through encrypted transport');
assert.match(transport, /if \(this\.ws === socket\) this\._onClose\(e\)/);
assert.match(transport, /this\._setSessionToken\(null\);/);
assert.match(transport, /handler\(this\._connected && this\._authenticated\)/,
  'Only authenticated, usable Vulcan connections should appear online');

console.log('Server profile migration, explicit switching, ordered isolation, rollback, and UI boundaries verified.');
