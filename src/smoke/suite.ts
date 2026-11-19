import assert from 'node:assert/strict';
import { commands, ConfigurationTarget, extensions, workspace, type StatusBarItem } from 'vscode';
import {
  readHoldingDescriptionFieldOrder,
  readHoldingHkdRate,
  readHoldingSummaryMode,
} from '../config';
import {
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_DESCRIPTION_FIELD_ORDER,
} from '../domain/holdings';
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
  'fishStock.selectHoldingsSummaryMode',
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
  const originalOrder = config.inspect<string[]>('treeViewFieldOrder')?.globalValue;
  const setFieldOrder = HoldingsTreeProvider.prototype.setFieldOrder;
  const descriptionDisplayChanged = HoldingsManagerPanel.prototype.descriptionDisplayChanged;
  let appliedOrder: readonly string[] | undefined;
  let managerDisplayUpdates = 0;
  HoldingsTreeProvider.prototype.setFieldOrder = function (order) {
    appliedOrder = order;
    setFieldOrder.call(this, order);
  };
  HoldingsManagerPanel.prototype.descriptionDisplayChanged = function () {
    managerDisplayUpdates += 1;
    descriptionDisplayChanged.call(this);
  };
  try {
    const nextOrder = ['profit', 'quantity', 'marketValue', 'weight', 'dayProfit'];
    const changed = new Promise<void>((resolve) => {
      const listener = workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('fishStock.holdings.treeViewFieldOrder')) {
          listener.dispose();
          resolve();
        }
      });
    });
    await config.update('treeViewFieldOrder', nextOrder, ConfigurationTarget.Global);
    await changed;
    assert.deepEqual(appliedOrder, nextOrder, 'Tree View 未即时收到字段顺序');
    assert.deepEqual(readHoldingDescriptionFieldOrder(), nextOrder);
    assert.ok(managerDisplayUpdates > 0, '持仓管理页未即时收到字段顺序');
  } finally {
    HoldingsTreeProvider.prototype.setFieldOrder = setFieldOrder;
    HoldingsManagerPanel.prototype.descriptionDisplayChanged = descriptionDisplayChanged;
    await config.update(
      'treeViewFieldOrder',
      originalOrder,
      ConfigurationTarget.Global,
    );
  }
  const originalSummaryMode = config.inspect<string>('summaryMode')?.globalValue;
  const setSummaryMode = HoldingsTreeProvider.prototype.setSummaryMode;
  const summaryModeChanged = HoldingsManagerPanel.prototype.summaryModeChanged;
  let appliedSummaryMode: string | undefined;
  let managerSummaryUpdates = 0;
  HoldingsTreeProvider.prototype.setSummaryMode = function (mode) {
    appliedSummaryMode = mode;
    setSummaryMode.call(this, mode);
  };
  HoldingsManagerPanel.prototype.summaryModeChanged = function () {
    managerSummaryUpdates += 1;
    summaryModeChanged.call(this);
  };
  try {
    const changed = new Promise<void>((resolve) => {
      const listener = workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('fishStock.holdings.summaryMode')) {
          listener.dispose();
          resolve();
        }
      });
    });
    await config.update('summaryMode', 'tag', ConfigurationTarget.Global);
    await changed;
    assert.equal(readHoldingSummaryMode(), 'tag');
    assert.equal(appliedSummaryMode, 'tag', 'Tree View 未即时收到汇总方式');
    assert.ok(managerSummaryUpdates > 0, '持仓管理页未即时收到汇总方式');
  } finally {
    HoldingsTreeProvider.prototype.setSummaryMode = setSummaryMode;
    HoldingsManagerPanel.prototype.summaryModeChanged = summaryModeChanged;
    await config.update(
      'summaryMode',
      originalSummaryMode,
      ConfigurationTarget.Global,
    );
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
  let summaryMode = readHoldingSummaryMode();
  let treeViewFields = { ...DEFAULT_HOLDING_DESCRIPTION_FIELDS };
  let treeViewFieldOrder = [...DEFAULT_HOLDING_DESCRIPTION_FIELD_ORDER];
  const manager = new HoldingsManagerPanel({
    repository, quoteOf: () => quote,
    search: async () => [instrument], watchlistEntries: () => [],
    refresh: async () => {}, colorConvention: () => 'china',
    hkdRate: () => 0.9, setHkdRate: async () => {},
    descriptionFields: () => ({ ...treeViewFields }),
    descriptionFieldOrder: () => [...treeViewFieldOrder],
    setDescriptionDisplay: async (fields, order) => {
      treeViewFields = { ...fields };
      treeViewFieldOrder = [...order];
      tree.setFieldFlags(treeViewFields);
      tree.setFieldOrder(treeViewFieldOrder);
    },
    summaryMode: () => summaryMode,
    setSummaryMode: async (mode) => {
      summaryMode = mode;
      tree.setSummaryMode(mode);
    },
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
      type: 'save',
      rows: [{
        symbol: instrument.symbol,
        tag: '核心',
        quantity: '123',
        averageCost: '50',
      }],
      cash: { amount: '1000', currency: 'CNY' },
    });
    assert.equal(applied, 1, '保存后没有同步持仓视图');
    assert.equal(repository.getSnapshot().holdings[0].quantity, 123);
    assert.equal(repository.getSnapshot().holdings[0].tag, '核心');
    assert.equal(repository.getSnapshot().cash?.amount, 1_000);
    const nodes = tree.getChildren();
    const node = nodes[0];
    assert.equal(node.kind, 'holding');
    assert.match(String(tree.getTreeItem(node).description), /123 股/);
    const cashNode = nodes.find((item) => item.kind === 'cash');
    assert.ok(cashNode, '保存现金后没有生成现金节点');
    assert.match(
      String(tree.getTreeItem(cashNode).description),
      /1,000\.00 CNY/,
    );
    const summaryNode = nodes.find((item) => item.kind === 'summary');
    assert.ok(summaryNode, '保存现金后没有生成总资产行');
    assert.match(
      String(tree.getTreeItem(summaryNode).description),
      /仓位 87\.12%/,
    );
    tree.setSummaryMode('tag');
    const tagSummary = tree.getChildren().find((item) => item.kind === 'summary');
    assert.ok(tagSummary);
    const summaryTooltip = tree.getTreeItem(tagSummary).tooltip as { value?: string };
    assert.match(summaryTooltip.value ?? '', /按标签汇总/);
    assert.match(summaryTooltip.value ?? '', /\*\*核心\*\*/);
    assert.match(summaryTooltip.value ?? '', /现金（未分组）/);
    await receiver.handleMessage({
      type: 'setDescriptionDisplay',
      fields: treeViewFields,
      order: ['profit', 'quantity', 'marketValue', 'weight', 'dayProfit'],
    });
    const reorderedHolding = tree.getChildren().find((item) => item.kind === 'holding');
    assert.ok(reorderedHolding);
    const reorderedDescription = String(tree.getTreeItem(reorderedHolding).description);
    assert.match(reorderedDescription, /^\+?[-\d,]+\(\+?[\d.]+%\)/);
    assert.doesNotMatch(reorderedDescription, /^123 股/);
    const item = Reflect.get(status, 'item') as StatusBarItem;
    assert.match(item.text, /\+615\.00 CNY/, '状态栏没有显示保存后的持仓盈亏');
  } finally {
    manager.dispose();
    status.dispose();
  }
}
