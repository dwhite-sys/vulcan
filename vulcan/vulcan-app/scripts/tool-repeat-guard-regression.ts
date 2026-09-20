import assert from 'node:assert/strict';
import { noteLocalToolRepeat, type ToolRepeatState } from '../src/app/services/toolRepeatGuard.ts';

function fresh() {
  return new Map<string, ToolRepeatState>();
}

{
  const state = fresh();
  assert.equal(noteLocalToolRepeat(state, 'A', 0), 1);
  assert.equal(noteLocalToolRepeat(state, 'A', 1), 2);
  assert.equal(noteLocalToolRepeat(state, 'A', 2), 3, 'tight A -> A -> A remains suppressible');
}

{
  const state = fresh();
  assert.equal(noteLocalToolRepeat(state, 'A', 0), 1);
  assert.equal(noteLocalToolRepeat(state, 'A', 3), 1, 'two complete intervening turns reset the streak');
}

{
  const state = fresh();
  assert.equal(noteLocalToolRepeat(state, 'A', 0), 1);
  assert.equal(noteLocalToolRepeat(state, 'A', 2), 2, 'one intervening turn is still considered nearby');
}

{
  const state = fresh();
  assert.equal(noteLocalToolRepeat(state, 'A', 4), 1);
  assert.equal(noteLocalToolRepeat(state, 'A', 4), 2);
  assert.equal(noteLocalToolRepeat(state, 'A', 4), 3, 'duplicate calls in one model turn are still caught');
}

{
  const state = fresh();
  assert.equal(noteLocalToolRepeat(state, 'A', 0), 1);
  assert.equal(noteLocalToolRepeat(state, 'B', 1), 1);
  assert.equal(noteLocalToolRepeat(state, 'C', 2), 1);
  assert.equal(noteLocalToolRepeat(state, 'A', 3), 1, 'A -> B -> C -> A is legitimate');
}

console.log('Tool repeat guard regression: ok');
