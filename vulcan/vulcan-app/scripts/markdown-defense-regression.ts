import assert from 'node:assert/strict';
import { codeChildrenToString, isIsolatedMarkdownFence } from '../src/app/services/markdownDefense.ts';

assert.equal(isIsolatedMarkdownFence('```html'), true);
assert.equal(isIsolatedMarkdownFence('```'), true);
assert.equal(isIsolatedMarkdownFence('  ```tsx  '), true);
assert.equal(isIsolatedMarkdownFence('~~~python'), true);
assert.equal(isIsolatedMarkdownFence('```html\n<div>real content</div>\n```'), false);
assert.equal(isIsolatedMarkdownFence('normal text'), false);
assert.equal(isIsolatedMarkdownFence(''), false);

assert.equal(codeChildrenToString(undefined), '');
assert.equal(codeChildrenToString(null), '');
assert.equal(codeChildrenToString('hello\n'), 'hello');
assert.notEqual(codeChildrenToString(undefined), 'undefined');

console.log('Markdown defense regression checks passed.');
