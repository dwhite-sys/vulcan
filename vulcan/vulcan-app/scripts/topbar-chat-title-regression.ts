import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const topbar = readFileSync(new URL('../src/app/components/TopBar.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../src/app/components/ChatInterface.tsx', import.meta.url), 'utf8');

assert.match(topbar, /gridTemplateColumns:[\s\S]*sidebarCollapsed[\s\S]*sidebarSizePercent/, 'top bar must mirror the resizable sidebar width');
assert.match(topbar, /Active chat title — starts exactly where the chat pane starts/, 'chat title must be anchored to the chat-pane boundary');
assert.match(topbar, /items-center justify-start px-4/, 'chat title must be left aligned within the chat pane');
assert.match(topbar, /\{chatTitle \? \(/, 'top bar must render the active chat title');
assert.match(topbar, /<GitBranch/, 'branch toggle must travel with the title cluster');
assert.match(topbar, /Model selector — right aligned immediately before Etna \/ Providers[\s\S]*<ModelSelector[\s\S]*Connection Status/, 'model selector must sit immediately before the connection status block');
assert.match(app, /chatTitle=\{displayChat\?\.title\}/, 'App must source the topbar title from the active chat');
assert.match(app, /canToggleBranchMode=\{Boolean\(displayChat\?\.events\.length\)\}/, 'branch toggle must only appear for an established transcript');
assert.match(app, /const \[sidebarSizePercent, setSidebarSizePercent\] = useState\(20\)/, 'App must track the live sidebar width for top-bar alignment');
assert.match(app, /onResize=\{setSidebarSizePercent\}/, 'resizing the sidebar must update top-bar title alignment');
assert.match(app, /sidebarSizePercent=\{sidebarSizePercent\}/, 'App must pass the live sidebar width to TopBar');
assert.doesNotMatch(chat, /h-12 shrink-0 items-center border-b border-ash-800 bg-ash-900\/80/, 'old transcript title strip must be removed');

console.log('topbar chat title regression: ok');
