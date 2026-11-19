import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHoldingBreakdownDetail,
  buildHoldingCashBreakdownDetail,
  buildHoldingGroupCatalog,
  DEFAULT_HOLDING_GROUP_NAME,
  holdingGroupAssignment,
  holdingTagName,
  normalizeHoldingSummaryMode,
  summarizeHoldingBreakdowns,
  UNTAGGED_HOLDING_NAME,
} from '../domain/holdingGroups';
import { summarizePortfolio } from '../domain/holdings';
import type {
  Holding,
  Quote,
  WatchlistState,
} from '../domain/models';

function quote(
  symbol: string,
  price: number,
  market: 'CN' | 'HK' = 'CN',
): Quote {
  return {
    symbol,
    market,
    name: symbol,
    currency: market === 'HK' ? 'HKD' : 'CNY',
    price,
    previousClose: price,
    open: null,
    high: null,
    low: null,
    volume: null,
    volumeUnit: null,
    turnoverAmount: null,
    turnoverRate: null,
    peTtm: null,
    totalMarketCap: null,
    settlementPrice: null,
    openInterest: null,
    change: 0,
    changePercent: 0,
    asOf: 1,
    state: 'closed',
  };
}

function stock(
  symbol: string,
  id = symbol,
): Holding {
  return {
    id,
    symbol,
    market: 'CN',
    kind: 'stock',
    name: symbol,
    quantity: 100,
    averageCost: 10,
  };
}

function fund(symbol: string): Holding {
  return {
    id: symbol,
    symbol,
    market: 'CN',
    kind: 'fund',
    name: symbol,
    quantity: 100,
    averageCost: 8,
  };
}

function watchlist(
  groups: Array<{ name: string; stocks: Array<{ symbol: string; market: 'CN' | 'HK' }> }>,
): WatchlistState {
  return {
    version: 1,
    groups: groups.map((group, index) => ({
      id: `group-${index}`,
      name: group.name,
      collapsed: false,
      stocks: group.stocks.map((item, stockIndex) => ({
        id: `stock-${index}-${stockIndex}`,
        symbol: item.symbol,
        market: item.market,
        name: item.symbol,
      })),
    })),
  };
}

test('builds stock and fund group assignments with a default fallback', () => {
  const stockWatchlist = watchlist([
    { name: '默认', stocks: [{ symbol: '600000.SH', market: 'CN' }] },
    { name: '银行', stocks: [{ symbol: '601398.SH', market: 'CN' }] },
    { name: '共同', stocks: [{ symbol: '600519.SH', market: 'CN' }] },
  ]);
  const fundWatchlist = watchlist([
    { name: '默认', stocks: [{ symbol: '510300.SH', market: 'CN' }] },
    { name: '共同', stocks: [{ symbol: '159915.SZ', market: 'CN' }] },
  ]);
  const catalog = buildHoldingGroupCatalog(stockWatchlist, fundWatchlist);

  assert.deepEqual(holdingGroupAssignment(stock('600000.SH'), catalog), {
    name: '默认',
    order: 0,
  });
  assert.deepEqual(holdingGroupAssignment(stock('601398.SH'), catalog), {
    name: '银行',
    order: 1,
  });
  assert.deepEqual(holdingGroupAssignment(stock('600519.SH'), catalog), {
    name: '共同',
    order: 2,
  });
  assert.deepEqual(holdingGroupAssignment(stock('000001.SZ'), catalog), {
    name: '默认',
    order: 0,
  });
  assert.deepEqual(holdingGroupAssignment(fund('159915.SZ'), catalog), {
    name: '共同',
    order: 2,
  });
});

test('keeps stock and fund instruments distinct and appends default last', () => {
  const stockWatchlist = watchlist([
    { name: '银行', stocks: [{ symbol: '510300.SH', market: 'CN' }] },
  ]);
  const fundWatchlist = watchlist([
    { name: 'ETF', stocks: [{ symbol: '510300.SH', market: 'CN' }] },
  ]);
  const catalog = buildHoldingGroupCatalog(stockWatchlist, fundWatchlist);

  assert.equal(holdingGroupAssignment(stock('510300.SH'), catalog).name, '银行');
  assert.equal(holdingGroupAssignment(fund('510300.SH'), catalog).name, 'ETF');
  assert.deepEqual(
    holdingGroupAssignment(stock('000001.SZ'), catalog),
    { name: DEFAULT_HOLDING_GROUP_NAME, order: 2 },
  );
});

test('summarizes groups by their own amounts and portfolio weights with cash', () => {
  const bank = stock('601398.SH');
  const tech = stock('000333.SZ');
  const stockWatchlist = watchlist([
    { name: '默认', stocks: [] },
    { name: '银行', stocks: [{ symbol: bank.symbol, market: 'CN' }] },
    { name: '科技', stocks: [{ symbol: tech.symbol, market: 'CN' }] },
  ]);
  const catalog = buildHoldingGroupCatalog(stockWatchlist, watchlist([]));
  const quotes = new Map([
    [bank.symbol, quote(bank.symbol, 20)],
    [tech.symbol, quote(tech.symbol, 15)],
  ]);
  const quoteOf = (holding: Holding): Quote | undefined => quotes.get(holding.symbol);
  const cash = { amount: 500, currency: 'CNY' as const };
  const portfolio = summarizePortfolio([bank, tech], cash, quoteOf);
  const groups = summarizeHoldingBreakdowns(
    [bank, tech],
    quoteOf,
    portfolio,
    {
      mode: 'group',
      groupOf: (holding) => holdingGroupAssignment(holding, catalog),
    },
  );

  assert.deepEqual(groups.map((group) => group.name), ['银行', '科技']);
  assert.equal(groups[0].summary.marketValue, 2_000);
  assert.equal(groups[0].weightPercent, 50);
  assert.equal(groups[1].summary.marketValue, 1_500);
  assert.equal(groups[1].weightPercent, 37.5);
  assert.equal(portfolio.cashPercent, 12.5);
  assert.equal(
    buildHoldingBreakdownDetail(groups[0]),
    '1 项 · 2,000 · 仓位 50.00% · +1,000(+100.00%)',
  );
  assert.equal(
    buildHoldingCashBreakdownDetail(cash, portfolio.cashPercent),
    '500.00 CNY · 仓位 12.50%',
  );
});

test('merges same-name Stock and Fund groups', () => {
  const stockHolding = stock('601398.SH');
  const fundHolding = fund('510300.SH');
  const stockWatchlist = watchlist([
    { name: '共同', stocks: [{ symbol: stockHolding.symbol, market: 'CN' }] },
  ]);
  const fundWatchlist = watchlist([
    { name: '共同', stocks: [{ symbol: fundHolding.symbol, market: 'CN' }] },
  ]);
  const catalog = buildHoldingGroupCatalog(stockWatchlist, fundWatchlist);
  const quotes = new Map([
    [stockHolding.symbol, quote(stockHolding.symbol, 20)],
    [fundHolding.symbol, quote(fundHolding.symbol, 10)],
  ]);
  const quoteOf = (holding: Holding): Quote | undefined => quotes.get(holding.symbol);
  const cash = { amount: 0, currency: 'CNY' as const };
  const portfolio = summarizePortfolio(
    [stockHolding, fundHolding],
    cash,
    quoteOf,
  );
  const groups = summarizeHoldingBreakdowns(
    [stockHolding, fundHolding],
    quoteOf,
    portfolio,
    {
      mode: 'group',
      groupOf: (holding) => holdingGroupAssignment(holding, catalog),
    },
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, '共同');
  assert.equal(groups[0].summary.itemCount, 2);
  assert.equal(groups[0].summary.marketValue, 3_000);

  const unwatched = stock('000001.SZ');
  const defaultCatalog = buildHoldingGroupCatalog(watchlist([]), watchlist([]));
  const defaultOnly = summarizeHoldingBreakdowns(
    [unwatched],
    () => quote(unwatched.symbol, 10),
    summarizePortfolio([unwatched], cash, () => quote(unwatched.symbol, 10)),
    {
      mode: 'group',
      groupOf: (holding) => holdingGroupAssignment(holding, defaultCatalog),
    },
  );
  assert.equal(defaultOnly[0].name, '默认');
});

test('marks a mixed-currency group uncombined without a rate', () => {
  const cny = stock('600000.SH');
  const hkd: Holding = {
    ...stock('00700.HK'),
    market: 'HK',
  };
  const stockWatchlist = watchlist([
    {
      name: '混合',
      stocks: [
        { symbol: cny.symbol, market: 'CN' },
        { symbol: hkd.symbol, market: 'HK' },
      ],
    },
  ]);
  const catalog = buildHoldingGroupCatalog(stockWatchlist, watchlist([]));
  const quotes = new Map([
    [cny.symbol, quote(cny.symbol, 20)],
    [hkd.symbol, quote(hkd.symbol, 20, 'HK')],
  ]);
  const quoteOf = (holding: Holding): Quote | undefined => quotes.get(holding.symbol);
  const cash = { amount: 0, currency: 'CNY' as const };
  const portfolio = summarizePortfolio([cny, hkd], cash, quoteOf, new Date(), null);
  const groups = summarizeHoldingBreakdowns(
    [cny, hkd],
    quoteOf,
    portfolio,
    {
      mode: 'group',
      groupOf: (holding) => holdingGroupAssignment(holding, catalog),
      now: new Date(),
      hkdRate: null,
    },
  );
  assert.equal(groups[0].summary.currency, null);
  assert.equal(groups[0].weightPercent, null);
  assert.equal(
    buildHoldingBreakdownDetail(groups[0]),
    '2 项 · 未合并：未启用港币折算',
  );
});

test('marks group rows with partial or entirely missing quotes', () => {
  const first = stock('600000.SH');
  const second = stock('000333.SZ');
  const stockWatchlist = watchlist([
    {
      name: '银行',
      stocks: [
        { symbol: first.symbol, market: 'CN' },
        { symbol: second.symbol, market: 'CN' },
      ],
    },
  ]);
  const catalog = buildHoldingGroupCatalog(stockWatchlist, watchlist([]));
  const cash = { amount: 0, currency: 'CNY' as const };
  const partialQuoteOf = (holding: Holding): Quote | undefined =>
    holding.id === first.id ? quote(first.symbol, 20) : undefined;
  const partialPortfolio = summarizePortfolio(
    [first, second],
    cash,
    partialQuoteOf,
  );
  const partial = summarizeHoldingBreakdowns(
    [first, second],
    partialQuoteOf,
    partialPortfolio,
    {
      mode: 'group',
      groupOf: (holding) => holdingGroupAssignment(holding, catalog),
    },
  );
  assert.equal(
    buildHoldingBreakdownDetail(partial[0]),
    '2 项 · 部分行情 · 2,000 · 仓位 100.00% · +1,000(+100.00%)',
  );

  const missingPortfolio = summarizePortfolio(
    [first, second],
    cash,
    () => undefined,
  );
  const missing = summarizeHoldingBreakdowns(
    [first, second],
    () => undefined,
    missingPortfolio,
    {
      mode: 'group',
      groupOf: (holding) => holdingGroupAssignment(holding, catalog),
    },
  );
  assert.equal(buildHoldingBreakdownDetail(missing[0]), '2 项 · 等待行情');
});

test('summarizes manual tags and places untagged holdings last', () => {
  const first = { ...stock('600000.SH'), tag: '核心' };
  const second = { ...fund('510300.SH'), tag: '  核心  ' };
  const third = { ...stock('000333.SZ'), tag: '银行' };
  const untagged = stock('600519.SH');
  const quoteOf = (holding: Holding): Quote => quote(holding.symbol, 10);
  const cash = { amount: 0, currency: 'CNY' as const };
  const holdings = [first, second, third, untagged];
  const portfolio = summarizePortfolio(holdings, cash, quoteOf);
  const groups = summarizeHoldingBreakdowns(
    holdings,
    quoteOf,
    portfolio,
    { mode: 'tag' },
  );

  assert.deepEqual(
    groups.map((group) => [group.name, group.summary.itemCount]),
    [
      ['核心', 2],
      ['银行', 1],
      [UNTAGGED_HOLDING_NAME, 1],
    ],
  );
  assert.equal(holdingTagName(second), '核心');
});

test('normalizes the summary mode to group unless tag is explicit', () => {
  assert.equal(normalizeHoldingSummaryMode('tag'), 'tag');
  assert.equal(normalizeHoldingSummaryMode('group'), 'group');
  assert.equal(normalizeHoldingSummaryMode('invalid'), 'group');
  assert.equal(normalizeHoldingSummaryMode(undefined), 'group');
});
