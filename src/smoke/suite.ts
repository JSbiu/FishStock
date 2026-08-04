import assert from 'node:assert/strict';
import { commands, extensions } from 'vscode';

const EXTENSION_ID = 'fishstock-local.fish-stock';

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
] as const;

export async function run(): Promise<void> {
  const extension = extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `未找到扩展 ${EXTENSION_ID}`);
  await extension.activate();
  assert.equal(extension.isActive, true, 'FishStock 扩展未激活');

  const registered = new Set(await commands.getCommands(true));
  for (const command of REQUIRED_COMMANDS) {
    assert.equal(registered.has(command), true, `命令未注册：${command}`);
  }

  await commands.executeCommand('fishStock.openWatchlist');
  await commands.executeCommand('fishStock.expandAllStockGroups');
  await commands.executeCommand('fishStock.openFunds');
  await commands.executeCommand('fishStock.expandAllFundGroups');
  await commands.executeCommand('fishStock.openFutures');
  await commands.executeCommand('fishStock.expandAllFuturesGroups');
}
