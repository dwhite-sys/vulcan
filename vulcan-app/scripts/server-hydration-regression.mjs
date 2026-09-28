import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const persistence = fs.readFileSync(new URL('../src/app/services/persistence.ts', import.meta.url), 'utf8');

// Only server-owned chat state hydrates from the authenticated Vulcan server.
// Provider/Etna definitions are client-owned and must survive server switches.
assert.match(app, /hydrateServerOwnedStateFromServer/);
assert.match(app, /onConnectionChange\(\(connected\)/);
assert.match(app, /if \(connected\) void hydrateServerOwnedStateFromServer\(\)/);
assert.match(app, /generalWS\.connected && vulcan\.generalWS\.authenticated[\s\S]*?hydrateServerOwnedStateFromServer\(\)/,
  'Hydration must also run when the authenticated socket connected before React subscribed');
assert.match(app, /Promise\.all\(\[loadChats\(\), loadChatFolders\(\)\]\)/);
assert.doesNotMatch(app, /providers\/list|providers\/current/);
assert.match(app, /setChats\(loadedChats\)/);
assert.match(app, /setChatFolders\(loadedFolders\)/);
assert.match(app, /setChatIndexHydrated\(true\)/);
assert.match(app, /Provider\/Etna definitions are client-owned/);
assert.match(app, /emptyText=\{chatIndexHydrated \? 'No chats yet' : 'Loading chats…'\}/);

// Chat persistence itself remains server-only with no browser fallback.
assert.match(persistence, /All chat persistence goes through the Vulcan server\. No localStorage fallback/);
assert.match(persistence, /remoteLoadChats\(\)/);
assert.match(persistence, /remoteLoadChatFolders\(\)/);

// A server switch explicitly clears chat hydration until the new server commits.
assert.match(app, /setChatIndexHydrated\(false\)/);

console.log('authenticated chat-only server hydration regression: ok');
