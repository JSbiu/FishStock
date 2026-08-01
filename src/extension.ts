import {
  window,
  workspace,
  type ExtensionContext,
} from 'vscode';
import {
  buildFuturesCommandSet,
  buildStockCommandSet,
} from './commands/commandSets';
import { registerWatchlistCommands } from './commands/registerWatchlistCommands';
import { readConfig } from './config';
import { BseSecurityDirectory } from './data/bseSecurityDirectory';
import { QuoteService } from './data/quoteService';
import { SinaFuturesProvider } from './data/sinaFuturesProvider';
import { TencentDataProvider } from './data/tencentDataProvider';
import type { Market, NormalizedSymbol } from './domain/models';
import { shouldAutoRefresh } from './domain/tradingCalendar';
import { RefreshScheduler } from './services/refreshScheduler';
import {
  createDefaultFuturesWatchlist,
  WatchlistRepository,
} from './storage/watchlistRepository';
import { ViewOptionsStore } from './storage/viewOptionsStore';
import { GroupNode, WatchlistTreeProvider } from './ui/watchlistTreeProvider';
import { StatusBarController } from './ui/statusBarController';

const MIN_FETCH_INTERVAL_MS = 10_000;

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel('FishStock');
  const stockRepository = new WatchlistRepository(context.globalState);
  const futuresRepository = new WatchlistRepository(context.globalState, {
    storageKey: 'fishStock.futures.v1',
    createDefault: createDefaultFuturesWatchlist,
  });
  const viewOptions = new ViewOptionsStore(context.globalState);
  await Promise.all([
    stockRepository.load(),
    futuresRepository.load(),
    viewOptions.load(),
  ]);

  let config = readConfig();
  const stockProvider = new TencentDataProvider({
    bseDirectory: new BseSecurityDirectory(context.globalState),
  });
  const futuresProvider = new SinaFuturesProvider();
  const stockQuotes = new QuoteService(
    stockProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
  );
  const futuresQuotes = new QuoteService(
    futuresProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
  );
  const stockTreeProvider = new WatchlistTreeProvider(
    stockRepository,
    stockQuotes,
    config.colorConvention,
    stockProvider.displayName,
    {},
    viewOptions.getSnapshot().stock,
  );
  const futuresTreeProvider = new WatchlistTreeProvider(
    futuresRepository,
    futuresQuotes,
    config.colorConvention,
    futuresProvider.displayName,
    {
      groupContextValue: 'fishStock.futuresGroup',
      itemContextValue: 'fishStock.future',
    },
    viewOptions.getSnapshot().futures,
  );
  const stockTreeView = window.createTreeView('fishStock.stock', {
    treeDataProvider: stockTreeProvider,
    showCollapseAll: true,
  });
  const futuresTreeView = window.createTreeView('fishStock.futures', {
    treeDataProvider: futuresTreeProvider,
    showCollapseAll: true,
  });

  const statusBar = new StatusBarController(config.rotationIntervalMs);
  const updateStatusBar = (): void => {
    statusBar.setSources([
      {
        state: stockRepository.getSnapshot(),
        quotes: stockQuotes,
        providerName: stockProvider.displayName,
        openCommand: 'fishStock.openWatchlist',
      },
      {
        state: futuresRepository.getSnapshot(),
        quotes: futuresQuotes,
        providerName: futuresProvider.displayName,
        openCommand: 'fishStock.openFutures',
      },
    ]);
  };
  updateStatusBar();

  const refreshStocks = async (force: boolean, manual: boolean): Promise<void> => {
    const state = stockRepository.getSnapshot();
    const symbols: NormalizedSymbol[] = state.groups.flatMap((group) =>
      group.stocks.map((stock) => ({ symbol: stock.symbol, market: stock.market })),
    );
    const result = await stockQuotes.refresh(symbols, force);
    stockTreeProvider.refresh();
    updateStatusBar();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 股票行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage('FishStock: 股票行情刷新失败，正在显示缓存', 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage('FishStock: 股票行情已刷新', 2_500);
    }
  };

  const refreshFutures = async (force: boolean, manual: boolean): Promise<void> => {
    const state = futuresRepository.getSnapshot();
    const symbols: NormalizedSymbol[] = state.groups.flatMap((group) =>
      group.stocks.map((future) => ({ symbol: future.symbol, market: future.market })),
    );
    const result = await futuresQuotes.refresh(symbols, force);
    futuresTreeProvider.refresh();
    updateStatusBar();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 期货行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage('FishStock: 期货行情刷新失败，正在显示缓存', 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage('FishStock: 期货行情已刷新', 2_500);
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([refreshStocks(false, false), refreshFutures(false, false)]);
  };

  const activeMarkets = (): Market[] => [
    ...new Set([
      ...stockRepository
        .getSnapshot()
        .groups.flatMap((group) => group.stocks.map((stock) => stock.market)),
      ...futuresRepository
        .getSnapshot()
        .groups.flatMap((group) => group.stocks.map((stock) => stock.market)),
    ]),
  ];
  const scheduler = new RefreshScheduler(config.refreshIntervalMs, async () => {
    try {
      if (shouldAutoRefresh(activeMarkets(), new Date())) {
        await refreshAll();
      }
    } catch (error: unknown) {
      output.appendLine(`[${new Date().toISOString()}] 刷新任务异常：${compactError(error)}`);
    }
  });

  context.subscriptions.push(
    output,
    stockTreeView,
    futuresTreeView,
    statusBar,
    scheduler,
    ...registerWatchlistCommands({
      repository: stockRepository,
      search: (query, signal) => stockProvider.searchStocks(query, signal),
      refresh: refreshStocks,
      viewOptions,
      treeProvider: stockTreeProvider,
      set: buildStockCommandSet(),
      registerCommonCommands: true,
    }),
    ...registerWatchlistCommands({
      repository: futuresRepository,
      search: (query, signal) => futuresProvider.searchFutures(query, signal),
      refresh: refreshFutures,
      viewOptions,
      treeProvider: futuresTreeProvider,
      set: buildFuturesCommandSet(),
    }),
    stockTreeView.onDidCollapseElement((event) => {
      if (event.element instanceof GroupNode) {
        void stockRepository.setGroupCollapsed(event.element.group.id, true);
      }
    }),
    stockTreeView.onDidExpandElement((event) => {
      if (event.element instanceof GroupNode) {
        void stockRepository.setGroupCollapsed(event.element.group.id, false);
      }
    }),
    futuresTreeView.onDidCollapseElement((event) => {
      if (event.element instanceof GroupNode) {
        void futuresRepository.setGroupCollapsed(event.element.group.id, true);
      }
    }),
    futuresTreeView.onDidExpandElement((event) => {
      if (event.element instanceof GroupNode) {
        void futuresRepository.setGroupCollapsed(event.element.group.id, false);
      }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('fishStock')) {
        return;
      }
      config = readConfig();
      stockQuotes.setStaleAfterMs(config.staleAfterMs);
      futuresQuotes.setStaleAfterMs(config.staleAfterMs);
      stockTreeProvider.setColorConvention(config.colorConvention);
      futuresTreeProvider.setColorConvention(config.colorConvention);
      statusBar.configure(config.rotationIntervalMs);
      scheduler.configure(config.refreshIntervalMs);
      void refreshAll();
    }),
  );

  scheduler.start();
  await refreshAll();
  output.appendLine('FishStock 已启动；股票使用腾讯行情，国内期货使用新浪行情。');
}

export function deactivate(): void {}
