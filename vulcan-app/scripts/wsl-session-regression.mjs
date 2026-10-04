import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWslSession } = require('../electron/wslSession.cjs');
const launched = [];
const timers = new Map();
let counter = 0;
const session = createWslSession({
  spawnProcess(command, args, options) {
    assert.equal(command, 'wsl.exe');
    assert.deepEqual(args, ['-d', 'Vulcan', '-u', 'vulcan', '--exec', 'bash', '-c', 'cat >/dev/null']);
    assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => { child.ended = true; };
    launched.push(child); return child;
  },
  schedule(fn, delay) { assert.equal(delay, 5000); const id = ++counter; timers.set(id, fn); return id; },
  cancel(id) { timers.delete(id); },
});
session.start(); session.start();
assert.equal(launched.length, 1);
launched[0].emit('error', new Error('WSL restarted'));
launched[0].emit('close', 1);
assert.equal(timers.size, 1, 'Error and close must schedule just one retry');
const [id, retry] = timers.entries().next().value;
timers.delete(id); retry();
assert.equal(launched.length, 2);
session.stop(); assert.equal(launched[1].ended, true);
launched[1].emit('close', 0); assert.equal(timers.size, 0);
session.start(); launched[2].emit('close', 1);
session.stop(); assert.equal(timers.size, 0, 'Quitting must cancel reconnection');
console.log('WSL desktop session lifetime, deduplication, reconnection, and EOF cleanup verified.');
