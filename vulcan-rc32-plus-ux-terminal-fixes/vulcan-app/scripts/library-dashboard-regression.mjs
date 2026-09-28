import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');
const [panel, settings, persistence, frontendTools, backendRuntime, docker, server, schemasText, dashboardSkill, frontendDashboardSkill, legacyDashboardSkill, compatibilityDashboardSkill, compatibilitySchemasText] = await Promise.all([
  read('../src/app/components/PanelViewer.tsx'),
  read('../src/app/components/SettingsDialog.tsx'),
  read('../src/app/services/persistence.ts'),
  read('../src/app/services/vulcanTools.ts'),
  read('../../vulcan/vulcan/agent_runtime.py'),
  read('../../vulcan/vulcan/docker.py'),
  read('../../vulcan/vulcan/server.py'),
  read('../../vulcan/vulcan/agent_assets/tool_schemas.json'),
  read('../../vulcan/vulcan/agent_assets/skills/dashboard-authoring/SKILL.md'),
  read('../src/app/skills/builtin/dashboard-authoring/SKILL.md'),
  read('../../vulcan/skills/dashboard-authoring/SKILL.md'),
  read('../../vulcan/agent_assets/skills/dashboard-authoring/SKILL.md'),
  read('../../vulcan/agent_assets/tool_schemas.json'),
]);

const schemas = JSON.parse(schemasText);
assert.deepEqual(schemas.library.map((tool) => tool.name), ['library_search', 'library_attach']);
assert.match(frontendTools, /name: 'library_search'/);
assert.match(frontendTools, /name: 'library_attach'/);
assert.match(backendRuntime, /settings\.get\("libraryEnabled", True\)/);
assert.match(persistence, /libraryEnabled: true/);
assert.match(settings, />Enable File Library</);
assert.match(settings, /uploadLibraryFile\(file\)/);
assert.match(docker, /dst=\/shared\/library,readonly/);
assert.match(docker, /dst=\/chats,readonly/);
assert.match(frontendTools, /every conversation's attachments and workspaces/);
assert.deepEqual(schemas.library[0].parameters.required, ['query']);
assert.match(schemas.library[0].description, /non-empty query is required/);
assert.match(schemas.library[0].description, /bella\.py decode\.py/);
assert.match(schemas.library[1].description, /complete conversation workspace/);
assert.match(server, /resp\.aiter_raw\(\)/);
assert.match(server, /message\.get\("text"\)/);
assert.match(server, /message\.get\("bytes"\)/);
assert.match(dashboardSkill, /window\.vulcan\.fetch/);
assert.match(dashboardSkill, /remote clients/);
assert.equal(frontendDashboardSkill, dashboardSkill, 'Frontend and authoritative dashboard skills must agree');
assert.equal(legacyDashboardSkill, dashboardSkill, 'Legacy dashboard skill must not advertise stale networking');
assert.equal(compatibilityDashboardSkill, dashboardSkill, 'Compatibility dashboard skill must match the authoritative copy');
assert.equal(compatibilitySchemasText, schemasText, 'Both server entrypoints must expose identical tool schemas');
assert.match(dashboardSkill, /--bind 127\.0\.0\.1/);
assert.match(dashboardSkill, /window\.vulcan\.websocket/);
assert.match(dashboardSkill, /window\.vulcan\.serviceUrl/);
assert.match(dashboardSkill, /window\.vulcan\.serviceWsUrl/);
assert.match(dashboardSkill, /remote client, that resolves to the user's device/);
assert.match(dashboardSkill, /does not isolate ports between chats/);
assert.doesNotMatch(dashboardSkill, /same chat's workspace container|existing container proxy/);

const createTool = schemas.panels.find((tool) => tool.name === 'dashboard_create');
const updateTool = schemas.panels.find((tool) => tool.name === 'dashboard_update');
for (const tool of [createTool, updateTool]) {
  const escapedName = tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const frontendTool = frontendTools.match(new RegExp(`name: '${escapedName}',\\s*description: "([^"]+)"`));
  assert.ok(frontendTool, `Frontend declaration for ${tool.name} must exist`);
  assert.equal(frontendTool[1], tool.description, `${tool.name} descriptions must be identical in frontend and server`);
}
assert.match(createTool.description, /live workspace services, remote-safe connections/);
assert.doesNotMatch(createTool.description, /container proxying/);
assert.match(updateTool.description, /replacing one part/);
assert.doesNotMatch(updateTool.description, /one or more parts/);
assert.deepEqual(updateTool.parameters.properties.part.enum, ['html', 'css', 'js']);
assert.match(dashboardSkill, /replace one part per call/);

const match = panel.match(/function injectContainerProxy\(documentHtml: string, chatId: string\): string \{([\s\S]*?)\n\}\n\nexport function/);
assert.ok(match, 'Dashboard proxy injector must be available');
const inject = new Function('documentHtml', 'chatId', 'getVulcanBaseUrl', 'generalWS', match[1]);
const html = inject('<html><body>Ready</body></html>', 'chat-with spaces',
  () => 'https://elite.example:9443/', { sessionToken: 'secret value' });
const script = html.match(/<script>\(function\(\)\{([\s\S]*?)\}\)\(\);<\/script>/);
assert.ok(script, 'Dashboard must receive its service helper before dashboard JavaScript');
const requests = [];
class Socket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
  }
}
const context = { window: {}, URL, WebSocket: Socket, fetch: (...args) => {
  requests.push(args);
  return Promise.resolve({ ok: true });
} };
vm.runInNewContext(`(function(){${script[1]}})()`, context);
const helpers = context.window.vulcan;
assert.equal(helpers.proxyUrl(8600, '/bundle.js?version=2'),
  'https://elite.example:9443/proxy/chat-with%20spaces/8600/bundle.js?version=2&vulcan_session=secret+value');
assert.equal(helpers.proxyWsUrl(8600, '/live'),
  'wss://elite.example:9443/proxy/ws/chat-with%20spaces/8600/live?vulcan_session=secret+value');
await helpers.fetch(8600, '/status', { method: 'POST' });
assert.equal(requests[0][0],
  'https://elite.example:9443/proxy/chat-with%20spaces/8600/status?vulcan_session=secret+value');
assert.deepEqual(requests[0][1], { method: 'POST' });
const socket = helpers.websocket(8600, '/events', ['json']);
assert.equal(socket.url,
  'wss://elite.example:9443/proxy/ws/chat-with%20spaces/8600/events?vulcan_session=secret+value');
assert.deepEqual(socket.protocols, ['json']);
assert.throws(() => helpers.serviceUrl(99999, '/'), /between 1 and 65535/);

console.log('Zero-copy library surfaces, protected Docker mount, remote-server HTTP/WS proxy helpers, authenticated query handling, and streamed service responses verified.');
