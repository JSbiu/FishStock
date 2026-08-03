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

function activationEvents(): string[] {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { activationEvents: string[] };
  return manifest.activationEvents;
}

function contributedViews(): Array<{ id: string; icon?: string }> {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { contributes: { views: Record<string, Array<{ id: string; icon?: string }>> } };
  return Object.values(manifest.contributes.views).flat();
}

test('every registered command id is declared in package.json', () => {
  const declared = new Set(declaredCommandIds());
  const ids = [
    ...Object.values(buildStockCommandSet().names),
    ...Object.values(buildFuturesCommandSet().names),
    'fishStock.openQuote',
    'fishStock.copyDiagnostics',
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

test('manifest only declares activation events that VS Code cannot generate', () => {
  assert.deepEqual(activationEvents(), ['onStartupFinished']);
});

test('every contributed view declares an icon', () => {
  for (const view of contributedViews()) {
    assert.equal(typeof view.icon, 'string', `${view.id} 缺少 icon`);
    assert.notEqual(view.icon, '', `${view.id} 的 icon 为空`);
  }
});
