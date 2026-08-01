import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFuturesCommandSet, buildStockCommandSet } from '../commands/commandSets';

function declaredCommandIds(): string[] {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { contributes: { commands: Array<{ command: string }> } };
  return manifest.contributes.commands.map((entry) => entry.command);
}

test('every registered command id is declared in package.json', () => {
  const declared = new Set(declaredCommandIds());
  const ids = [
    ...Object.values(buildStockCommandSet().names),
    ...Object.values(buildFuturesCommandSet().names),
    'fishStock.openQuote',
  ].filter((id) => !id.endsWith('.focus'));
  for (const id of ids) {
    assert.equal(declared.has(id), true, `${id} 未在 package.json 声明`);
  }
});

test('stock and futures command ids do not collide', () => {
  const stock = Object.values(buildStockCommandSet().names);
  const futures = Object.values(buildFuturesCommandSet().names);
  const overlap = stock.filter((id) => futures.includes(id));
  assert.deepEqual(overlap, []);
});

test('stock and futures command sets keep their own focus views', () => {
  assert.equal(buildStockCommandSet().names.focusView, 'fishStock.stock.focus');
  assert.equal(buildFuturesCommandSet().names.focusView, 'fishStock.futures.focus');
});
