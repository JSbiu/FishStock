import {
  commands,
  env,
  ExtensionMode,
  window,
  workspace,
  version as vscodeVersion,
  type ExtensionContext,
  type TreeView,
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
import {
  formatDiagnosticReport,
  summarizeWatchlist,
  type DiagnosticRefreshState,
} from './domain/diagnostics';
import type { Market, NormalizedSymbol } from './domain/models';
import { isTradingDay, shouldAutoRefresh } from './domain/tradingCalendar';
import { RefreshScheduler } from './services/refreshScheduler';
import {
  createDefaultFuturesWatchlist,
  WatchlistRepository,
} from './storage/watchlistRepository';
import { ViewOptionsStore } from './storage/viewOptionsStore';
import {
  GroupNode,
  WatchlistTreeProvider,
  type FishTreeNode,
} from './ui/watchlistTreeProvider';
import { StatusBarController } from './ui/statusBarController';

const MIN_FETCH_INTERVAL_MS = 10_000;

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function extensionVersion(context: ExtensionContext): string {
  const manifest: unknown = context.extension.packageJSON;
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    return '未知';
  }
  return typeof manifest.version === 'string' ? manifest.version : '未知';
}

async function expandAllGroups(
  repository: WatchlistRepository,
  provider: WatchlistTreeProvider,
  treeView: TreeView<FishTreeNode>,
): Promise<void> {
  await repository.expandAllGroups();
  provider.refresh();
  for (const group of provider.getGroupNodes()) {
    await treeView.reveal(group, { expand: true, focus: false, select: false });
  }
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
  let stockRefreshState: DiagnosticRefreshState = 'not-run';
  let stockRefreshAt: string | undefined;
  let futuresRefreshState: DiagnosticRefreshState = 'not-run';
  let futuresRefreshAt: string | undefined;
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
    stockRefreshState = result.error ? 'error' : 'success';
    stockRefreshAt = new Date().toISOString();
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
    futuresRefreshState = result.error ? 'error' : 'success';
    futuresRefreshAt = new Date().toISOString();
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
  const diagnosticReport = (): string => {
    const tradingDays: Partial<Record<Market, boolean>> = {};
    const now = new Date();
    for (const market of activeMarkets()) {
      tradingDays[market] = isTradingDay(market, now);
    }
    const modes = viewOptions.getSnapshot();
    return formatDiagnosticReport({
      generatedAt: now.toISOString(),
      extensionVersion: extensionVersion(context),
      vscodeVersion,
      platform: `${process.platform}-${process.arch}`,
      config: {
        refreshIntervalSeconds: config.refreshIntervalMs / 1000,
        staleAfterSeconds: config.staleAfterMs / 1000,
        rotationSeconds: config.rotationIntervalMs / 1000,
        colorConvention: config.colorConvention,
      },
      viewModes: { stock: modes.stock, futures: modes.futures },
      tradingDays,
      stock: summarizeWatchlist(
        stockRepository.getSnapshot(),
        stockProvider.displayName,
        (symbol) => stockQuotes.get(symbol)?.state,
        stockRefreshState,
        stockRefreshAt,
      ),
      futures: summarizeWatchlist(
        futuresRepository.getSnapshot(),
        futuresProvider.displayName,
        (symbol) => futuresQuotes.get(symbol)?.state,
        futuresRefreshState,
        futuresRefreshAt,
      ),
    });
  };
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
    commands.registerCommand('fishStock.copyDiagnostics', async () => {
      await env.clipboard.writeText(diagnosticReport());
      window.setStatusBarMessage('FishStock: 已复制脱敏诊断信息', 3_000);
    }),
    ...registerWatchlistCommands({
      repository: stockRepository,
      search: (query, signal) => stockProvider.searchStocks(query, signal),
      refresh: refreshStocks,
      expandAll: () => expandAllGroups(stockRepository, stockTreeProvider, stockTreeView),
      viewOptions,
      treeProvider: stockTreeProvider,
      set: buildStockCommandSet(),
      registerCommonCommands: true,
    }),
    ...registerWatchlistCommands({
      repository: futuresRepository,
      search: (query, signal) => futuresProvider.searchFutures(query, signal),
      refresh: refreshFutures,
      expandAll: () => expandAllGroups(
        futuresRepository,
        futuresTreeProvider,
        futuresTreeView,
      ),
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

  if (context.extensionMode !== ExtensionMode.Test) {
    scheduler.start();
    await refreshAll();
  }
  output.appendLine('FishStock 已启动；股票使用腾讯行情，国内期货使用新浪行情。');
}

export function deactivate(): void {}
