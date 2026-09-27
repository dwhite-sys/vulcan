import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/app/components/KitSidebar.tsx', import.meta.url), 'utf8');
const graph = readFileSync(new URL('../src/app/components/BranchGraph.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../src/app/components/ChatInterface.tsx', import.meta.url), 'utf8');
const topbar = readFileSync(new URL('../src/app/components/TopBar.tsx', import.meta.url), 'utf8');
const branching = readFileSync(new URL('../src/app/services/branching.ts', import.meta.url), 'utf8');

assert.doesNotMatch(chat, /GitBranch/, 'chat transcript must not own the branch toggle chrome');
assert.doesNotMatch(chat, /chatTitle/, 'chat transcript must not render a separate title strip');
assert.match(topbar, /Active chat title — starts exactly where the chat pane starts/, 'top bar must place the chat title in the former model slot');
assert.match(topbar, /canToggleBranchMode[\s\S]*<GitBranch/, 'top bar title cluster must own the branch toggle');
assert.match(topbar, /Model selector — right aligned immediately before Etna \/ Providers/, 'model selector must move into the right-hand connection cluster');
assert.match(app, /selectedBranchId/, 'branch selection must be independent application state');
assert.match(app, /transcriptViewId=\{`\$\{displayChat\.id\}:branch:\$\{selectedBranch\.id\}`\}/,
  'branch preview transcript identity must include the selected branch id');
assert.match(app, /transcriptViewId=\{`\$\{displayChat\.id\}:main`\}/,
  'normal transcript scroll state must remain separate from branch previews');
assert.match(chat, /transcriptViewId\?: string/,
  'ChatInterface must accept a projection-specific transcript identity');
assert.match(app, /createBranch\(currentChat, 'jump'/, 'sending from a historical selection must materialize a JUMP branch');
assert.match(app, /createBranch\(activeChat, 'edit'/, 'message edits must preserve the old path as an EDIT branch');
assert.match(app, /createBranch\(activeChat, 'regen'/, 'retry must preserve the old path as a REGEN branch');
assert.match(app, /sort\(\(a, b\) => new Date\(b\.createdAt\).*new Date\(a\.createdAt\)/s, 'branch traversal/search order must remain newest-first');
assert.match(sidebar, /placeholder=\{branchMode \? "Search branches"/, 'the existing sidebar search control must mutate in place for branch mode');
assert.match(sidebar, /branch\.origin\.toUpperCase\(\).*toLocaleTimeString/s, 'branch rows must use TYPE · time metadata');
assert.match(sidebar, /selected=\{branch\.id === selectedBranchId\}/, 'selected branch highlight must be independent of search filtering');
assert.match(sidebar, /branchSearchMatches\.get\(branch\.id\)/, 'each matching branch must preserve its own transcript hits');
assert.match(graph, /Pencil/, 'graph nodes must expose the same rename affordance');
assert.match(graph, /onRenameBranch/, 'graph rename must update shared branch state');
assert.match(graph, /absolute z-10/, 'branch cards must stack above connector SVGs so lines never bleed through historical cards');
assert.match(graph, /bg-ash-900 px-3 py-2\.5/, 'all branch cards must use an opaque base surface');
assert.match(graph, /selectedHistorical && <span[^>]*text-coral-400[^>]*>SELECTED<\/span>/, 'historical selection must use an orange SELECTED status with CURRENT-style grammar');
assert.match(graph, /current \? 'border-coral-800\/70/, 'current branch must retain a subtle orange highlight');
assert.match(branching, /titleSource: 'user'/, 'manual rename must freeze the automatic title');
assert.match(branching, /stableBoundary/, 'automatic branch titles must refine only at stable transcript boundaries');
assert.match(app, /vulcan\.searchBranches\(activeChat\.id, query\)/, 'branch search must use the server-owned branch-aware search engine');
assert.match(app, /firstSearchMatchPerEvent\(searchTranscript\(selectedBranchEvents/, 'branch search must compute exact navigation only for the selected branch');
assert.match(branching, /parentId: string \| null|parentId/, 'branch topology must remain parent-only');

console.log('branch UI regression: ok');
