import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHoldingGroupCatalog,
  buildHoldingGroupCashDescription,
  buildHoldingGroupDescriptionSegments,
  DEFAULT_HOLDING_GROUP_NAME,
  holdingGroupAssignment,
  summarizeHoldingGroups,
} from '../domain/holdingGroups';
import {
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  summarizePortfolio,
} from '../domain/holdings';
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
  const overview = summarizeHoldingGroups(
    [bank, tech],
    cash,
    quoteOf,
    (holding) => holdingGroupAssignment(holding, catalog),
    portfolio,
  );

  assert.deepEqual(overview.groups.map((group) => group.name), ['银行', '科技']);
  assert.equal(overview.groups[0].summary.marketValue, 2_000);
  assert.equal(overview.groups[0].weightPercent, 50);
  assert.equal(overview.groups[1].summary.marketValue, 1_500);
  assert.equal(overview.groups[1].weightPercent, 37.5);
  assert.equal(overview.cashWeightPercent, 12.5);
  assert.equal(overview.shouldShow, true);
  assert.deepEqual(
    buildHoldingGroupDescriptionSegments(
      overview.groups[0],
      DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    ),
    ['1 项', '2,000', '仓位 50.00%', '+1,000(+100.00%)', '今日—'],
  );
  assert.equal(
    buildHoldingGroupCashDescription(cash, overview.cashWeightPercent),
    '500.00 CNY · 仓位 12.50%',
  );
});

test('merges same-name Stock and Fund groups and hides a default-only total', () => {
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
  const overview = summarizeHoldingGroups(
    [stockHolding, fundHolding],
    cash,
    quoteOf,
    (holding) => holdingGroupAssignment(holding, catalog),
    portfolio,
  );
  assert.equal(overview.groups.length, 1);
  assert.equal(overview.groups[0].name, '共同');
  assert.equal(overview.groups[0].summary.itemCount, 2);
  assert.equal(overview.groups[0].summary.marketValue, 3_000);

  const unwatched = stock('000001.SZ');
  const defaultCatalog = buildHoldingGroupCatalog(watchlist([]), watchlist([]));
  const defaultOnly = summarizeHoldingGroups(
    [unwatched],
    cash,
    () => quote(unwatched.symbol, 10),
    (holding) => holdingGroupAssignment(holding, defaultCatalog),
    summarizePortfolio([unwatched], cash, () => quote(unwatched.symbol, 10)),
  );
  assert.equal(defaultOnly.groups[0].name, '默认');
  assert.equal(defaultOnly.shouldShow, false);
  const withCash = summarizeHoldingGroups(
    [unwatched],
    { amount: 100, currency: 'CNY' },
    () => quote(unwatched.symbol, 10),
    (holding) => holdingGroupAssignment(holding, defaultCatalog),
    summarizePortfolio(
      [unwatched],
      { amount: 100, currency: 'CNY' },
      () => quote(unwatched.symbol, 10),
    ),
  );
  assert.equal(withCash.shouldShow, true);
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
  const overview = summarizeHoldingGroups(
    [cny, hkd],
    cash,
    quoteOf,
    (holding) => holdingGroupAssignment(holding, catalog),
    portfolio,
    new Date(),
    null,
  );
  assert.equal(overview.groups[0].summary.currency, null);
  assert.equal(overview.groups[0].weightPercent, null);
  assert.deepEqual(
    buildHoldingGroupDescriptionSegments(
      overview.groups[0],
      DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    ),
    ['2 项', '未合并：未启用港币折算'],
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
  const partial = summarizeHoldingGroups(
    [first, second],
    cash,
    partialQuoteOf,
    (holding) => holdingGroupAssignment(holding, catalog),
    partialPortfolio,
  );
  assert.deepEqual(
    buildHoldingGroupDescriptionSegments(
      partial.groups[0],
      DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    ),
    ['2 项', '部分行情', '2,000', '仓位 100.00%', '+1,000(+100.00%)', '今日—'],
  );

  const missingPortfolio = summarizePortfolio(
    [first, second],
    cash,
    () => undefined,
  );
  const missing = summarizeHoldingGroups(
    [first, second],
    cash,
    () => undefined,
    (holding) => holdingGroupAssignment(holding, catalog),
    missingPortfolio,
  );
  assert.deepEqual(
    buildHoldingGroupDescriptionSegments(
      missing.groups[0],
      DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    ),
    ['2 项', '等待行情'],
  );
});
