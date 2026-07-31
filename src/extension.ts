import {
  window,
  workspace,
  type ExtensionContext,
} from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { readConfig } from './config';
import { BseSecurityDirectory } from './data/bseSecurityDirectory';
import { QuoteService } from './data/quoteService';
import { TencentDataProvider } from './data/tencentDataProvider';
import type { NormalizedSymbol } from './domain/models';
import { RefreshScheduler } from './services/refreshScheduler';
import { WatchlistRepository } from './storage/watchlistRepository';
import { GroupNode, WatchlistTreeProvider } from './ui/watchlistTreeProvider';
import { StatusBarController } from './ui/statusBarController';

const MIN_FETCH_INTERVAL_MS = 10_000;

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel('FishStock');
  const repository = new WatchlistRepository(context.globalState);
  await repository.load();

  let config = readConfig();
  const provider = new TencentDataProvider({
    bseDirectory: new BseSecurityDirectory(context.globalState),
  });
  const quotes = new QuoteService(
    provider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
  );
  const treeProvider = new WatchlistTreeProvider(
    repository,
    quotes,
    config.colorConvention,
    provider.displayName,
  );
  const treeView = window.createTreeView('fishStock.stock', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const statusBar = new StatusBarController(
    quotes,
    config.rotationIntervalMs,
    provider.displayName,
  );
  statusBar.setState(repository.getSnapshot());

  const refresh = async (force: boolean, manual: boolean): Promise<void> => {
    const state = repository.getSnapshot();
    const symbols: NormalizedSymbol[] = state.groups.flatMap((group) =>
      group.stocks.map((stock) => ({ symbol: stock.symbol, market: stock.market })),
    );
    const result = await quotes.refresh(symbols, force);
    treeProvider.refresh();
    statusBar.setState(state);
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage('FishStock: 刷新失败，正在显示缓存', 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage('FishStock: 已刷新', 2_500);
    }
  };

  const scheduler = new RefreshScheduler(config.refreshIntervalMs, async () => {
    try {
      await refresh(false, false);
    } catch (error: unknown) {
      output.appendLine(`[${new Date().toISOString()}] 刷新任务异常：${compactError(error)}`);
    }
  });

  context.subscriptions.push(
    output,
    treeView,
    statusBar,
    scheduler,
    ...registerCommands({ repository, provider, refresh }),
    treeView.onDidCollapseElement((event) => {
      if (event.element instanceof GroupNode) {
        void repository.setGroupCollapsed(event.element.group.id, true);
      }
    }),
    treeView.onDidExpandElement((event) => {
      if (event.element instanceof GroupNode) {
        void repository.setGroupCollapsed(event.element.group.id, false);
      }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('fishStock')) {
        return;
      }
      config = readConfig();
      quotes.setStaleAfterMs(config.staleAfterMs);
      treeProvider.setColorConvention(config.colorConvention);
      statusBar.configure(config.rotationIntervalMs);
      scheduler.configure(config.refreshIntervalMs);
      void refresh(false, false);
    }),
  );

  scheduler.start();
  await refresh(false, false);
  output.appendLine('FishStock 已启动；当前使用腾讯 A 股与港股行情。');
}

export function deactivate(): void {}
