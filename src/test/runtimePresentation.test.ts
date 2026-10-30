import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type {
  Holding,
  HoldingsState,
  Quote,
  Stock,
  WatchlistState,
} from '../domain/models';
import type {
  HoldingDescriptionFields,
  HoldingSortState,
} from '../domain/holdings';
import type { ColorConvention } from '../config';
import type { ViewMode } from '../domain/viewOptions';

class FakeTreeItem {
  public id: string | undefined;
  public contextValue: string | undefined;
  public description: string | boolean | undefined;
  public tooltip: unknown;
  public iconPath: unknown;
  public resourceUri: unknown;
  public command: unknown;

  public constructor(
    public label: string,
    public collapsibleState = 0,
  ) {}
}

class FakeThemeIcon {
  public constructor(
    public readonly id: string,
    public readonly color?: unknown,
  ) {}
}

class FakeThemeColor {
  public constructor(public readonly id: string) {}
}

class FakeUri {
  public constructor(public readonly value: string) {}

  public get scheme(): string {
    return this.value.split(':', 1)[0];
  }

  public static parse(value: string): FakeUri {
    return new FakeUri(value);
  }
}

class FakeEventEmitter {
  public readonly event = (): void => {};
  public fire(): void {}
}

const vscodeMock = {
  EventEmitter: FakeEventEmitter,
  ThemeColor: FakeThemeColor,
  ThemeIcon: FakeThemeIcon,
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  Uri: FakeUri,
  StatusBarAlignment: { Left: 1 },
};

interface LoadedModule {
  [name: string]: unknown;
}

function loadUiModule(
  moduleName: string,
  mocks: Readonly<Record<string, unknown>>,
  additions: Readonly<Record<string, unknown>> = {},
): LoadedModule {
  const modulePath = require.resolve(moduleName);
  const localRequire = createRequire(modulePath);
  const module = { exports: {} as unknown };
  runInNewContext(readFileSync(modulePath, 'utf8'), {
    module,
    exports: module.exports,
    require: (name: string) => mocks[name] ?? localRequire(name),
    ...additions,
  });
  return module.exports as LoadedModule;
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: '600000.SH',
    market: 'CN',
    name: '浦发银行',
    currency: 'CNY',
    price: 10,
    previousClose: 9.9,
    open: 9.9,
    high: 10.1,
    low: 9.8,
    volume: 1_000,
    volumeUnit: 'share',
    turnoverAmount: 10_000,
    turnoverRate: 1,
    peTtm: 8,
    totalMarketCap: 100_000,
    settlementPrice: null,
    openInterest: null,
    change: 0.1,
    changePercent: 1,
    asOf: Date.now(),
    state: 'live',
    sessionLabel: '开市',
    ...overrides,
  };
}

const quoteTooltipMock = {
  createQuoteTooltip: () => ({}),
  formatPercent: (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
  formatPrice: (value: number): string => value.toFixed(value < 10 ? 3 : 2),
  quoteStaleLabel: (): string => '数据过期',
};

const stock: Stock = {
  id: 'stock',
  symbol: '600000.SH',
  market: 'CN',
  name: '浦发银行',
};

test('watchlist Tree View shows suspension ahead of live and restores normally', () => {
  type WatchlistProvider = {
    getTreeItem(element: unknown): FakeTreeItem;
  };
  const module = loadUiModule('../ui/watchlistTreeProvider', {
    vscode: vscodeMock,
    './quoteTooltip': quoteTooltipMock,
  });
  const Provider = module.WatchlistTreeProvider as new (
    repository: { getSnapshot(): WatchlistState },
    quotes: { get(symbol: string): Quote | undefined },
    colorConvention: ColorConvention,
    providerName: string,
    options: { groupContextValue?: string; itemContextValue?: string },
    viewMode: ViewMode,
    holdingKeys: () => ReadonlySet<string>,
  ) => WatchlistProvider;
  const Node = module.StockNode as new (
    groupId: string,
    stock: Stock,
    quote: Quote | undefined,
  ) => unknown;
  const repository = {
    getSnapshot: (): WatchlistState => ({
      version: 1,
      groups: [{ id: 'g', name: '默认', collapsed: false, stocks: [stock] }],
    }),
  };
  let current = quote({ suspended: true });
  const provider = new Provider(
    repository,
    { get: () => current },
    'china',
    '固定样本',
    {},
    'default',
    () => new Set(),
  );
  const suspended = provider.getTreeItem(new Node('g', stock, current));
  assert.equal(suspended.description, '10.00 · 停牌');
  assert.equal((suspended.iconPath as FakeThemeIcon).id, 'debug-pause');

  current = quote({ suspended: false });
  const resumed = provider.getTreeItem(new Node('g', stock, current));
  assert.equal(resumed.description, '10.00  +1.00%');
  assert.equal((resumed.iconPath as FakeThemeIcon).id, 'arrow-up');
});

test('Holdings Tree View labels the default rate and keeps the selected sort context', () => {
  type HoldingsProvider = {
    getChildren(): unknown[];
    getTreeItem(element: unknown): FakeTreeItem;
    setHkdRate(rate: number | null): void;
  };
  const module = loadUiModule('../ui/holdingsTreeProvider', {
    vscode: vscodeMock,
    './quoteTooltip': quoteTooltipMock,
    './holdingTooltip': { createHoldingTooltip: () => ({}) },
  });
  const Provider = module.HoldingsTreeProvider as new (
    repository: { getSnapshot(): HoldingsState },
    options: {
      quoteOf(holding: Holding): Quote | undefined;
      providerNameOf(holding: Holding): string;
    },
    colorConvention: ColorConvention,
    sort: HoldingSortState,
    fields: HoldingDescriptionFields,
    hkdRate: number | null,
  ) => HoldingsProvider;
  const holding: Holding = {
    id: 'hk',
    symbol: '00700.HK',
    market: 'HK',
    kind: 'stock',
    name: '腾讯控股',
    quantity: 100,
    averageCost: 400,
  };
  const hkQuote = quote({
    symbol: holding.symbol,
    market: 'HK',
    name: holding.name,
    currency: 'HKD',
    price: 420,
  });
  const provider = new Provider(
    {
      getSnapshot: (): HoldingsState => ({
        version: 1,
        holdings: [holding],
      }),
    },
    {
      quoteOf: () => hkQuote,
      providerNameOf: () => '固定样本',
    },
    'china',
    { key: 'profitAmount', desc: true },
    { quantity: true, marketValue: true, profit: true, dayProfit: true },
    0.9,
  );
  const children = provider.getChildren();
  const holdingNode = children.find(
    (node) => (node as { kind?: string }).kind === 'holding',
  );
  const summaryNode = children.find(
    (node) => (node as { kind?: string }).kind === 'summary',
  );
  assert.ok(holdingNode);
  assert.ok(summaryNode);
  assert.equal(
    provider.getTreeItem(holdingNode).contextValue,
    'fishStock.holdingSorted',
  );
  assert.match(
    String(provider.getTreeItem(summaryNode).description),
    /汇率 0\.9（默认）/,
  );
  provider.setHkdRate(0.8557);
  const updatedSummary = provider.getChildren().find(
    (node) => (node as { kind?: string }).kind === 'summary',
  );
  assert.ok(updatedSummary);
  const description = String(provider.getTreeItem(updatedSummary).description);
  assert.match(description, /汇率 0\.8557/);
  assert.doesNotMatch(description, /汇率 0\.8557（默认）/);
});

test('status bar gives suspension priority in quote and holding modes', () => {
  interface StatusItem {
    text: string;
    tooltip: unknown;
    command: unknown;
    name: string;
    show(): void;
    dispose(): void;
  }
  const item: StatusItem = {
    text: '',
    tooltip: undefined,
    command: undefined,
    name: '',
    show: () => {},
    dispose: () => {},
  };
  type StatusController = {
    setSources(sources: unknown[]): void;
    setHoldingSource(source: unknown): void;
    setMode(mode: 'quotes' | 'holdings'): void;
    dispose(): void;
  };
  const module = loadUiModule(
    '../ui/statusBarController',
    {
      vscode: {
        StatusBarAlignment: { Left: 1 },
        window: { createStatusBarItem: () => item },
      },
      './holdingTooltip': { createHoldingTooltip: () => ({}) },
      './quoteTooltip': quoteTooltipMock,
    },
    { setInterval, clearInterval },
  );
  const Controller = module.StatusBarController as new (
    rotationIntervalMs: number,
    mode: 'quotes' | 'holdings',
  ) => StatusController;
  const controller = new Controller(60_000, 'quotes');
  let current = quote({ suspended: true });
  const source = {
    kind: 'stock',
    state: {
      version: 1,
      groups: [{ id: 'g', name: '默认', collapsed: false, stocks: [stock] }],
    },
    quotes: { get: () => current },
    providerName: '固定样本',
    openCommand: 'fishStock.openWatchlist',
    isGroupIncluded: () => true,
  };
  controller.setSources([source]);
  assert.match(item.text, /\$\(debug-pause\).*停牌/);
  assert.doesNotMatch(item.text, /\+1\.00%/);

  current = quote({ suspended: false });
  controller.setSources([source]);
  assert.match(item.text, /\$\(pulse\).*\+1\.00%/);

  const holding: Holding = {
    id: 'holding',
    symbol: '600000.SH',
    market: 'CN',
    kind: 'stock',
    name: '浦发银行',
    quantity: 100,
    averageCost: 9,
  };
  current = quote({ suspended: true });
  controller.setMode('holdings');
  controller.setHoldingSource({
    state: { version: 1, holdings: [holding] },
    quoteOf: () => current,
    providerNameOf: () => '固定样本',
    openCommand: 'fishStock.openHoldings',
  });
  assert.match(item.text, /\$\(debug-pause\).*\+100\.00 CNY/);
  current = quote({ suspended: false });
  controller.setHoldingSource({
    state: { version: 1, holdings: [holding] },
    quoteOf: () => current,
    providerNameOf: () => '固定样本',
    openCommand: 'fishStock.openHoldings',
  });
  assert.match(item.text, /\$\(pulse\).*\+100\.00 CNY/);
  controller.dispose();
});
