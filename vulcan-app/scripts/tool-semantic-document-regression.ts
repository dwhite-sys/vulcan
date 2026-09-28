import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalToolDocument } from '../src/app/services/toolSemanticDocument.ts';

const fixture = canonicalToolDocument('Web_Automation', {
  name: 'browser_start',
  description: 'Start a visible Browser',
  parameters: { properties: {
    headless_mode: { type: 'boolean', description: 'Run without a visible window' },
    profile: { type: 'string', description: 'Browser profile name' },
  } },
});
const expected = 'browser start start a visible browser web automation headless mode profile run without a visible window browser profile name';
assert.equal(fixture, expected);
assert.equal(createHash('sha256').update(fixture, 'utf8').digest('hex'), '5ec519d0859931ed7db85991e87fdb5d0264ea0a08fe064cb0d5d1fe1b891598');
console.log('Semantic tool document canonicalization regression: ok');
