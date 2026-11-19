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

class FakeMarkdownString {
  public value = '';
  public supportThemeIcons = false;

  public appendMarkdown(value: string): FakeMarkdownString {
    this.value += value;
    return this;
  }

  public appendText(value: string): FakeMarkdownString {
    this.value += value;
    return this;
  }
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
  MarkdownString: FakeMarkdownString,
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
  quoteStaleLabel: (item: Quote): string =>
    item.staleReason === 'calendar-uncovered' ? '日历未覆盖' : '数据过期',
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
    { quantity: true, marketValue: true, weight: true, profit: true, dayProfit: true },
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

test('Holdings Tree View shows cash and per-holding position weights', () => {
  type HoldingsProvider = {
    getChildren(): unknown[];
    getTreeItem(element: unknown): FakeTreeItem;
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
    id: 'cn',
    symbol: '600000.SH',
    market: 'CN',
    kind: 'stock',
    name: '浦发银行',
    quantity: 100,
    averageCost: 10,
  };
  const current = quote({
    symbol: holding.symbol,
    market: 'CN',
    currency: 'CNY',
    price: 20,
    previousClose: 19,
    change: 1,
  });
  const state: HoldingsState = {
    version: 1,
    holdings: [holding],
    cash: { amount: 1_000, currency: 'CNY' },
  };
  const provider = new Provider(
    { getSnapshot: () => state },
    {
      quoteOf: () => current,
      providerNameOf: () => '固定样本',
    },
    'china',
    { key: 'manual', desc: true },
    {
      quantity: true,
      marketValue: true,
      weight: true,
      profit: true,
      dayProfit: true,
    },
    null,
  );
  const children = provider.getChildren() as Array<{ kind?: string }>;
  const holdingNode = children.find((node) => node.kind === 'holding');
  const cashNode = children.find((node) => node.kind === 'cash');
  const summaryNode = children.find((node) => node.kind === 'summary');
  assert.ok(holdingNode);
  assert.ok(cashNode);
  assert.ok(summaryNode);

  assert.match(
    String(provider.getTreeItem(holdingNode).description),
    /占比 66\.67%/,
  );
  const cashItem = provider.getTreeItem(cashNode);
  assert.match(String(cashItem.description), /1,000\.00 CNY/);
  assert.match(String(cashItem.description), /33\.33%/);
  assert.equal(cashItem.contextValue, 'fishStock.holdingCash');
  const summaryItem = provider.getTreeItem(summaryNode);
  assert.match(String(summaryItem.label), /总资产/);
  assert.match(String(summaryItem.description), /仓位 66\.67%/);
});

test('Holdings Tree View applies the configured description field order', () => {
  type HoldingsProvider = {
    getChildren(): unknown[];
    getTreeItem(element: unknown): FakeTreeItem;
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
    fieldOrder: readonly string[],
  ) => HoldingsProvider;
  const holding: Holding = {
    id: 'cn',
    symbol: '600000.SH',
    market: 'CN',
    kind: 'stock',
    name: '浦发银行',
    quantity: 100,
    averageCost: 10,
  };
  const current = quote({
    symbol: holding.symbol,
    price: 20,
    previousClose: 20,
    change: 0,
  });
  const provider = new Provider(
    {
      getSnapshot: (): HoldingsState => ({ version: 1, holdings: [holding] }),
    },
    {
      quoteOf: () => current,
      providerNameOf: () => '固定样本',
    },
    'china',
    { key: 'manual', desc: true },
    {
      quantity: true,
      marketValue: true,
      weight: true,
      profit: true,
      dayProfit: true,
    },
    null,
    ['dayProfit', 'profit', 'quantity', 'marketValue', 'weight'],
  );
  const holdingNode = provider.getChildren().find(
    (node) => (node as { kind?: string }).kind === 'holding',
  );
  assert.ok(holdingNode);
  assert.equal(
    provider.getTreeItem(holdingNode).description,
    '今日— · +1,000(+100.00%) · 100 股 · 2,000 · 占比 100.00%',
  );
});

test('Holdings Tree View shows group and tag breakdowns in the total tooltip', () => {
  type HoldingsProvider = {
    getChildren(): Array<{ kind?: string }>;
    getTreeItem(element: unknown): FakeTreeItem;
    setSummaryMode(mode: 'group' | 'tag'): void;
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
      groupOf(holding: Holding): { name: string; order: number };
    },
    colorConvention: ColorConvention,
    sort: HoldingSortState,
    fields: HoldingDescriptionFields,
    hkdRate: number | null,
  ) => HoldingsProvider;
  const bank: Holding = {
    id: 'bank',
    symbol: '601398.SH',
    market: 'CN',
    kind: 'stock',
    name: '工商银行',
    tag: '核心',
    quantity: 100,
    averageCost: 5,
  };
  const tech: Holding = {
    id: 'tech',
    symbol: '000333.SZ',
    market: 'CN',
    kind: 'stock',
    name: '美的集团',
    quantity: 100,
    averageCost: 10,
  };
  const quotes = new Map([
    [bank.symbol, quote({ symbol: bank.symbol, price: 10 })],
    [tech.symbol, quote({ symbol: tech.symbol, price: 20 })],
  ]);
  const state: HoldingsState = {
    version: 1,
    holdings: [bank, tech],
    cash: { amount: 500, currency: 'CNY' },
  };
  const provider = new Provider(
    { getSnapshot: () => state },
    {
      quoteOf: (holding) => quotes.get(holding.symbol),
      providerNameOf: () => '固定样本',
      groupOf: (holding) => holding.id === bank.id
        ? { name: '银行', order: 1 }
        : { name: '科技', order: 2 },
    },
    'china',
    { key: 'manual', desc: true },
    {
      quantity: true,
      marketValue: true,
      weight: true,
      profit: true,
      dayProfit: true,
    },
    null,
  );
  const root = provider.getChildren();
  const summary = root.find((node) => node.kind === 'summary');
  assert.ok(summary);
  assert.equal(
    root.some((node) => node.kind === 'groupParent' || node.kind === 'group'),
    false,
  );
  const groupTooltip = provider.getTreeItem(summary).tooltip as { value?: string };
  assert.match(groupTooltip.value ?? '', /按分组汇总/);
  assert.match(groupTooltip.value ?? '', /\*\*银行\*\*/);
  assert.match(groupTooltip.value ?? '', /仓位 28\.57%/);
  assert.match(groupTooltip.value ?? '', /\*\*现金（未分组）\*\*/);
  assert.match(groupTooltip.value ?? '', /仓位 14\.29%/);

  provider.setSummaryMode('tag');
  const tagSummary = provider.getChildren().find((node) => node.kind === 'summary');
  assert.ok(tagSummary);
  const tagTooltip = provider.getTreeItem(tagSummary).tooltip as { value?: string };
  assert.match(tagTooltip.value ?? '', /按标签汇总/);
  assert.match(tagTooltip.value ?? '', /\*\*核心\*\*/);
  assert.match(tagTooltip.value ?? '', /\*\*未标注\*\*/);
});

test('Holdings Tree View passes total assets into position-weight sorting', () => {
  type HoldingsProvider = {
    getChildren(): Array<{ kind?: string; holding?: Holding }>;
    getTreeItem(element: unknown): FakeTreeItem;
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
  const small: Holding = {
    id: 'small',
    symbol: '600000.SH',
    market: 'CN',
    kind: 'stock',
    name: '小仓',
    quantity: 100,
    averageCost: 10,
  };
  const large: Holding = {
    id: 'large',
    symbol: '000333.SZ',
    market: 'CN',
    kind: 'stock',
    name: '大仓',
    quantity: 100,
    averageCost: 10,
  };
  const quotes = new Map([
    [small.symbol, quote({ symbol: small.symbol, price: 10 })],
    [large.symbol, quote({ symbol: large.symbol, price: 20 })],
  ]);
  const provider = new Provider(
    {
      getSnapshot: (): HoldingsState => ({
        version: 1,
        holdings: [small, large],
        cash: { amount: 1_000, currency: 'CNY' },
      }),
    },
    {
      quoteOf: (holding) => quotes.get(holding.symbol),
      providerNameOf: () => '固定样本',
    },
    'china',
    { key: 'weight', desc: true },
    {
      quantity: true,
      marketValue: true,
      weight: true,
      profit: true,
      dayProfit: true,
    },
    null,
  );
  assert.deepEqual(
    provider.getChildren()
      .filter((node) => node.kind === 'holding')
      .map((node) => node.holding?.id),
    ['large', 'small'],
  );
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

test('uncovered calendar quotes use the stale icon and concise label', () => {
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
  const current = quote({
    state: 'stale',
    staleReason: 'calendar-uncovered',
    sessionPhase: 'unknown',
    sessionLabel: '交易日历未覆盖',
  });
  const provider = new Provider(
    repository,
    { get: () => current },
    'china',
    '固定样本',
    {},
    'default',
    () => new Set(),
  );
  const item = provider.getTreeItem(new Node('g', stock, current));
  assert.equal(item.description, '10.00  +1.00% · 日历未覆盖');
  assert.equal((item.iconPath as FakeThemeIcon).id, 'history');
});
