import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');
const [app, chat, transport, docker, runtime, server, terminalSkill, dashboardSkill] = await Promise.all([
  read('../src/app/App.tsx'),
  read('../src/app/components/ChatInterface.tsx'),
  read('../src/app/services/vulcan.ts'),
  read('../../vulcan/vulcan/docker.py'),
  read('../../vulcan/vulcan/agent_runtime.py'),
  read('../../vulcan/vulcan/server.py'),
  read('../../vulcan/vulcan/agent_assets/skills/terminal/SKILL.md'),
  read('../../vulcan/vulcan/agent_assets/skills/dashboard-authoring/SKILL.md'),
]);

assert.doesNotMatch(app, /Global Container|globalSection|containerScope|global_chat/);
assert.doesNotMatch(chat, /Global Container|isGlobal/);
assert.doesNotMatch(transport, /global_chat/);
assert.match(app, /chats=\{chats\}/);
assert.match(app, /folders=\{chatFolders\}/);
assert.match(docker, /"--network", "host"/);
assert.doesNotMatch(docker, /ensure_global|"--dns"|NET_ADMIN/);
assert.match(docker, /openssh-client/);
assert.match(docker, /"commit", container_name\(chat_id\), migrated_image/);
assert.match(docker, /return "127\.0\.0\.1"/);
assert.match(runtime, /Networking uses the host network/);
assert.doesNotMatch(runtime, /containerScope|global container/);
assert.match(server, /_retire_obsolete_global_container/);
assert.doesNotMatch(server, /_keep_global_running|global_environment/);
assert.match(terminalSkill, /Tailscale/);
assert.match(terminalSkill, /SSH is available/);
assert.match(terminalSkill, /choose an unused port/);
assert.match(dashboardSkill, /host loopback/);

console.log('Single chat type, host networking, SSH/VPN access, old-container migration, loopback dashboard proxies, and global-container retirement verified.');
