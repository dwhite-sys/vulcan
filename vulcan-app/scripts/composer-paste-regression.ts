import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makePastedTextFile, nextPastedTextFilename, PASTE_TEXT_THRESHOLD } from '../src/app/utils/composerPaste.ts';

assert.equal(PASTE_TEXT_THRESHOLD, 500);

const composerSource = await readFile(new URL('../src/app/components/MessageComposer.tsx', import.meta.url), 'utf8');
assert.match(composerSource, /File as FileIcon/, 'Lucide File icon must not shadow the browser File constructor/type');
assert.doesNotMatch(composerSource, /import\s*\{[^}]*\bFile\b(?!\s+as\s+FileIcon)[^}]*\}\s*from\s*['"]lucide-react['"]/, 'Do not import Lucide File under the DOM File name');
assert.equal(nextPastedTextFilename([]), 'pasted-text.txt');
assert.equal(nextPastedTextFilename(['pasted-text.txt']), 'pasted-text-2.txt');
assert.equal(nextPastedTextFilename(['pasted-text.txt', 'pasted-text-2.txt']), 'pasted-text-3.txt');
assert.equal(nextPastedTextFilename(['other.txt', 'pasted-text-2.txt']), 'pasted-text.txt');

const json = JSON.stringify({ payload: 'x'.repeat(PASTE_TEXT_THRESHOLD + 50) });
const first = makePastedTextFile(json, []);
assert.equal(first.name, 'pasted-text.txt');
assert.equal(first.type, 'text/plain');
assert.equal(await first.text(), json);

const second = makePastedTextFile(json, [first.name]);
assert.equal(second.name, 'pasted-text-2.txt');
assert.equal(await second.text(), json);

// Mirror ChatInterface.addFiles' filename-dedupe behavior to prove a repeated
// large paste is accepted rather than being prevented and silently dropped.
const queued: File[] = [];
const addFiles = (incoming: File[]) => {
  const existingNames = new Set(queued.map((file) => file.name));
  queued.push(...incoming.filter((file) => !existingNames.has(file.name)));
};
addFiles([first]);
addFiles([second]);
assert.equal(queued.length, 2);
assert.deepEqual(queued.map((file) => file.name), ['pasted-text.txt', 'pasted-text-2.txt']);
assert.deepEqual(await Promise.all(queued.map((file) => file.text())), [json, json]);

console.log('composer paste regression: ok');
