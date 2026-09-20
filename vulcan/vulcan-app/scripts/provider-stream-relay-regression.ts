import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const ws = read('src/app/services/ws.ts');
const app = read('src/app/App.tsx');

assert.match(ws, /async push\(type: string, payload: any = \{\}\): Promise<void>/);
assert.match(ws, /await this\.ws\.send\(\{ type, payload \}, priority\)/);
assert.doesNotMatch(ws, /async push[\s\S]*?this\.pending\.set/, 'one-way stream push must not allocate an RPC pending promise');
assert.match(app, /generalWS\.push\('client\/http-chunk'/);
assert.match(app, /if \(data\) emitChunk\(data\)/);
assert.match(app, /const emit = \(event: Record<string, any>\) =>[\s\S]*generalWS\.push\('client\/http-event'/, 'relay control frames are ordered one-way traffic');
assert.match(app, /await emit\(\{ event: 'done' \}\)/, 'completion is flushed after all queued chunks');
assert.doesNotMatch(app, /if \(data\) await emit\(\{ event: 'chunk', data \}\)/, 'provider chunks must not wait for RPC acknowledgements');

console.log('Provider stream relay regression: ok');

const serverRuntime = fs.readFileSync(path.resolve(root, '../vulcan/agent_runtime.py'), 'utf8');
const relayRuntime = fs.readFileSync(path.resolve(root, '../vulcan/etna_registry.py'), 'utf8');
const llm = read('src/app/services/llm.ts');
assert.match(serverRuntime, /if data == "\[DONE\]":\s*return True/);
assert.match(serverRuntime, /choice\.get\("finish_reason"\) is not None/);
assert.match(serverRuntime, /await provider_stream\.aclose\(\)/);
assert.match(relayRuntime, /if not completed:[\s\S]*push\/client-http-cancel/);
assert.match(llm, /if \(payload === '\[DONE\]'\) return true/);
assert.match(llm, /choice\?\.finish_reason != null/);
