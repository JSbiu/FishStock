import assert from 'node:assert/strict';
import { commands, ConfigurationTarget, extensions, workspace, type StatusBarItem } from 'vscode';
import { readHoldingHkdRate } from '../config';
import type { Quote } from '../domain/models';
import { HoldingsRepository } from '../storage/holdingsRepository';
import { HoldingsTreeProvider } from '../ui/holdingsTreeProvider';
import { HoldingsManagerPanel } from '../ui/holdingsManagerPanel';
import { StatusBarController } from '../ui/statusBarController';

const EXTENSION_ID = 'jsbiu.fish-stock';

const REQUIRED_COMMANDS = [
  'fishStock.addStock',
  'fishStock.addFuture',
  'fishStock.addFund',
  'fishStock.refresh',
  'fishStock.refreshFutures',
  'fishStock.refreshFunds',
  'fishStock.stockViewMode',
  'fishStock.futuresViewMode',
  'fishStock.fundViewMode',
  'fishStock.expandAllStockGroups',
  'fishStock.expandAllFuturesGroups',
  'fishStock.expandAllFundGroups',
  'fishStock.copyDiagnostics',
  'fishStock.selectStatusBarGroups',
  'fishStock.addHolding',
  'fishStock.manageHoldings',
  'fishStock.editHolding',
  'fishStock.removeHolding',
  'fishStock.refreshHoldings',
  'fishStock.openHoldings',
  'fishStock.selectStatusBarMode',
] as const;

export async function run(): Promise<void> {
  const extension = extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `未找到扩展 ${EXTENSION_ID}`);
  await extension.activate();
  assert.equal(extension.isActive, true, 'FishStock 扩展未激活');

  if (process.env.FISHSTOCK_SMOKE_RELOAD === '1') {
    assert.equal(readHoldingHkdRate(), 0.8557, '重新启动后未保留港币汇率');
    return;
  }

  const registered = new Set(await commands.getCommands(true));
  for (const command of REQUIRED_COMMANDS) {
    assert.equal(registered.has(command), true, `命令未注册：${command}`);
  }

  await commands.executeCommand('fishStock.openWatchlist');
  await commands.executeCommand('fishStock.expandAllStockGroups');
  await commands.executeCommand('fishStock.openFunds');
  await commands.executeCommand('fishStock.expandAllFundGroups');
  await commands.executeCommand('fishStock.openFutures');
  await commands.executeCommand('fishStock.futures.focus');
  await commands.executeCommand('fishStock.expandAllFuturesGroups');
  await commands.executeCommand('fishStock.openHoldings');
  await commands.executeCommand('fishStock.manageHoldings');

  const config = workspace.getConfiguration('fishStock.holdings');
  const originalRate = config.inspect<number | null>('hkdToCnyRate')?.globalValue;
  const setTreeRate = HoldingsTreeProvider.prototype.setHkdRate;
  const updateManagerQuotes = HoldingsManagerPanel.prototype.updateQuotes;
  let appliedRate: number | null | undefined;
  let managerUpdates = 0;
  HoldingsTreeProvider.prototype.setHkdRate = function (rate) {
    appliedRate = rate;
    setTreeRate.call(this, rate);
  };
  HoldingsManagerPanel.prototype.updateQuotes = function () {
    managerUpdates += 1;
    updateManagerQuotes.call(this);
  };
  try {
    for (const rate of [0.8557, 0.9, null, undefined]) {
      const previousUpdates = managerUpdates;
      const changed = new Promise<void>((resolve) => {
        const listener = workspace.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration('fishStock.holdings.hkdToCnyRate')) {
            listener.dispose();
            resolve();
          }
        });
      });
      await config.update('hkdToCnyRate', rate, ConfigurationTarget.Global);
      await changed;
      const expectedRate = rate === undefined ? 0.9 : rate;
      assert.equal(readHoldingHkdRate(), expectedRate);
      assert.equal(appliedRate, expectedRate, 'Tree View 未即时收到当前汇率');
      assert.ok(managerUpdates > previousUpdates, '持仓管理页未即时收到配置更新');
    }
  } finally {
    HoldingsTreeProvider.prototype.setHkdRate = setTreeRate;
    HoldingsManagerPanel.prototype.updateQuotes = updateManagerQuotes;
    await config.update('hkdToCnyRate', originalRate, ConfigurationTarget.Global);
  }
  await config.update('hkdToCnyRate', 0.8557, ConfigurationTarget.Global);
  await verifySavedHoldingViews();
}

async function verifySavedHoldingViews(): Promise<void> {
  const instrument = { symbol: '000333.SZ', market: 'CN', kind: 'stock', name: '持仓验收样例' } as const;
  const quote: Quote = {
    symbol: instrument.symbol, market: 'CN', name: instrument.name, currency: 'CNY',
    price: 55, previousClose: 54, open: null, high: null, low: null,
    volume: null, volumeUnit: null, turnoverAmount: null, turnoverRate: null,
    peTtm: null, totalMarketCap: null, settlementPrice: null, openInterest: null,
    change: 1, changePercent: 100 / 54, asOf: Date.now(), state: 'closed',
  };
  const repository = new HoldingsRepository({
    get: <T>() => ({ version: 1, holdings: [] }) as T,
    update: async () => {},
  });
  await repository.load();
  const tree = new HoldingsTreeProvider(repository, {
    quoteOf: () => quote, providerNameOf: () => '固定样本',
  }, 'china');
  const status = new StatusBarController(60_000, 'holdings');
  let applied = 0;
  const manager = new HoldingsManagerPanel({
    repository, quoteOf: () => quote,
    search: async () => [instrument], watchlistEntries: () => [],
    refresh: async () => {}, colorConvention: () => 'china',
    hkdRate: () => 0.9, setHkdRate: async () => {},
    afterSave: async (added) => {
      assert.equal(added.length, 1);
      applied += 1;
      tree.refresh();
      status.setHoldingSource({
        state: repository.getSnapshot(), quoteOf: () => quote,
        providerNameOf: () => '固定样本', openCommand: 'fishStock.openHoldings',
      });
      manager.repositoryChanged();
    },
  });
  // 页面消息由浏览器回归覆盖；此处在真实 Extension Host 中验证同一保存处理器与原生视图。
  const receiver = manager as unknown as { handleMessage(message: unknown): Promise<void> };
  try {
    manager.show();
    await receiver.handleMessage({ type: 'ready' });
    await receiver.handleMessage({ type: 'search', query: instrument.name, requestId: 1 });
    await receiver.handleMessage({
      type: 'save', rows: [{ symbol: instrument.symbol, quantity: '123', averageCost: '50' }],
    });
    assert.equal(applied, 1, '保存后没有同步持仓视图');
    assert.equal(repository.getSnapshot().holdings[0].quantity, 123);
    const node = tree.getChildren()[0];
    assert.equal(node.kind, 'holding');
    assert.match(String(tree.getTreeItem(node).description), /123 股/);
    const item = Reflect.get(status, 'item') as StatusBarItem;
    assert.match(item.text, /\+615\.00 CNY/, '状态栏没有显示保存后的持仓盈亏');
  } finally {
    manager.dispose();
    status.dispose();
  }
}
