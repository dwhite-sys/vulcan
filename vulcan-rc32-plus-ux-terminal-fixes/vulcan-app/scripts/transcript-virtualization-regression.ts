import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const renderer = fs.readFileSync(path.join(appRoot, 'src/app/components/TranscriptRenderer.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(appRoot, 'src/app/components/ChatInterface.tsx'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));

assert.equal(pkg.dependencies['@tanstack/react-virtual'], '3.14.10', 'React Virtual must be a pinned runtime dependency');
assert.equal(lock.packages['node_modules/@tanstack/react-virtual']?.version, '3.14.10', 'lockfile must include React Virtual');
assert.equal(lock.packages['node_modules/@tanstack/virtual-core']?.version, '3.17.8', 'lockfile must include React Virtual core');

assert.match(renderer, /import \{ useVirtualizer \} from '@tanstack\/react-virtual';/, 'renderer must use TanStack React Virtual');
assert.match(renderer, /count:\s*blocks\.length/, 'virtualizer count must match canonical transcript blocks');
assert.match(renderer, /getScrollElement:\s*\(\) => props\.scrollElementRef\.current/, 'virtualizer must own the existing transcript viewport');
assert.match(renderer, /overscan:\s*TRANSCRIPT_OVERSCAN_BLOCKS/, 'virtualizer must retain an overscan window');
assert.match(renderer, /const TRANSCRIPT_OVERSCAN_BLOCKS = 2;/, 'transcript overscan must stay at two blocks to bound retained offscreen DOM');
assert.match(renderer, /getItemKey:\s*\(index\) => transcriptBlockKey\(blocks\[index\], index\)/, 'virtual rows need stable transcript keys');
assert.match(renderer, /ref=\{virtualizer\.measureElement\}/, 'variable-height transcript blocks must be measured');
assert.match(renderer, /data-index=\{virtualRow\.index\}/, 'TanStack measurement must receive each row index');
assert.match(renderer, /height:\s*`\$\{virtualizer\.getTotalSize\(\)\}px`/, 'offscreen rows must retain scroll geometry');
assert.match(renderer, /transform:\s*`translateY\(\$\{virtualRow\.start\}px\)`/, 'mounted rows must use virtual offsets');
assert.match(renderer, /data-transcript-total-blocks=\{blocks\.length\}/, 'logical block count must be inspectable in browser tests/profiling');
assert.match(renderer, /data-transcript-block-index=\{virtualRow\.index\}/, 'mounted virtual rows must be inspectable in browser tests/profiling');
assert.match(chat, /scrollElementRef=\{messagesViewportRef\}/, 'ChatInterface must pass its actual scroll viewport');
assert.doesNotMatch(chat, /ref=\{messagesContentRef\} className="divide-y divide-zinc-800"/, 'divider styling must not assume all transcript blocks are mounted in normal flow');

const fullMapMatches = renderer.match(/blocks\.map\s*\(/g) ?? [];
assert.equal(fullMapMatches.length, 0, 'TranscriptRenderer must not mount the entire block list directly');
assert.match(renderer, /virtualItems\.map\(/, 'TranscriptRenderer must mount only the virtual item window');

console.log('transcript virtualization regression: ok');
