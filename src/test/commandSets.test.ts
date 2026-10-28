import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFundCommandSet,
  buildFuturesCommandSet,
  buildStockCommandSet,
} from '../commands/commandSets';

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

test('futures search labels October codes as month contracts', () => {
  const describe = buildFuturesCommandSet().texts.describeSearchResult;
  for (const symbol of ['RB0.CNF', 'RB2610.CNF', 'RB2710.CNF', 'TA610.CNF']) {
    const result = describe({ symbol, market: 'CNF', kind: 'future', name: symbol });
    assert.equal(result.description, `${symbol} · ${symbol === 'RB0.CNF' ? '主连' : '月份合约'}`);
  }
});

test('every registered command id is declared in package.json', () => {
  const declared = new Set(declaredCommandIds());
  const ids = [
    ...Object.values(buildStockCommandSet().names),
    ...Object.values(buildFundCommandSet().names),
    ...Object.values(buildFuturesCommandSet().names),
    'fishStock.openQuote',
    'fishStock.copyDiagnostics',
    'fishStock.selectStatusBarGroups',
    'fishStock.addHolding',
    'fishStock.manageHoldings',
    'fishStock.editHolding',
    'fishStock.removeHolding',
    'fishStock.refreshHoldings',
    'fishStock.clearHoldings',
    'fishStock.openHoldings',
    'fishStock.openHoldingQuote',
    'fishStock.selectStatusBarMode',
  ];
  for (const id of ids) {
    assert.equal(declared.has(id), true, `${id} 未在 package.json 声明`);
  }
});

test('manifest command ids are unique', () => {
  const ids = declaredCommandIds();
  assert.equal(new Set(ids).size, ids.length);
});

test('stock, fund and futures command ids do not collide', () => {
  const ids = [
    ...Object.values(buildStockCommandSet().names),
    ...Object.values(buildFundCommandSet().names),
    ...Object.values(buildFuturesCommandSet().names),
  ];
  assert.equal(new Set(ids).size, ids.length);
});

test('open commands do not target a specific view focus', () => {
  const ids = [
    ...Object.values(buildStockCommandSet().names),
    ...Object.values(buildFundCommandSet().names),
    ...Object.values(buildFuturesCommandSet().names),
  ];
  assert.equal(ids.some((id) => id.endsWith('.focus')), false);
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

test('manifest contributes Stock, Fund, Futures and Holdings views', () => {
  assert.deepEqual(
    contributedViews().map((view) => view.id),
    [
      'fishStock.stock',
      'fishStock.fund',
      'fishStock.futures',
      'fishStock.holdings',
    ],
  );
});
