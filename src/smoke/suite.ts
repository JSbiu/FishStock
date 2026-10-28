import assert from 'node:assert/strict';
import { commands, ConfigurationTarget, extensions, workspace } from 'vscode';
import { readHoldingHkdRate } from '../config';
import { HoldingsTreeProvider } from '../ui/holdingsTreeProvider';
import { HoldingsManagerPanel } from '../ui/holdingsManagerPanel';

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
}
