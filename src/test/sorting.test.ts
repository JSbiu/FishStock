import assert from 'node:assert/strict';
import test from 'node:test';
import { moveItem } from '../domain/sorting';

test('moves an item while leaving the source array unchanged', () => {
  const source = ['A', 'B', 'C'];
  const result = moveItem(source, 1, -1);
  assert.deepEqual(result, ['B', 'A', 'C']);
  assert.deepEqual(source, ['A', 'B', 'C']);
});
test('keeps order at list boundaries', () => {
  assert.deepEqual(moveItem(['A', 'B'], 0, -1), ['A', 'B']);
  assert.deepEqual(moveItem(['A', 'B'], 1, 1), ['A', 'B']);
});
