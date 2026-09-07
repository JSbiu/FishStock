import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCurrencySummarySegments,
  buildHoldingDescriptionSegments,
  calculateHoldingMetrics,
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_SORT,
  ensureAtLeastOneField,
  holdingDayChange,
  holdingIconKindOf,
  holdingSortLabel,
  moveHoldingWithinCurrency,
  sortHoldings,
  summarizeHoldingCurrency,
  type HoldingDescriptionFields,
} from '../domain/holdings';
import type { Holding, Quote } from '../domain/models';

const holding: Holding = {
  id: 'one',
  symbol: '600519.SH',
  market: 'CN',
  kind: 'stock',
  name: '贵州茅台',
  quantity: 100,
  averageCost: 1_490,
};

function quote(
  price: number | null,
  state: Quote['state'] = 'live',
  overrides: Partial<Quote> = {},
): Quote {
  return {
    symbol: holding.symbol,
    market: holding.market,
    name: holding.name ?? holding.symbol,
    currency: 'CNY',
    price,
    previousClose: 1_480,
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
    change: price === null ? null : price - 1_480,
    changePercent: price === null ? null : ((price - 1_480) / 1_480) * 100,
    asOf: 1_000_000,
    state,
    ...overrides,
  };
}

const TRADING_DAY = '2026-09-03';
const SESSION_START = Date.parse('2026-09-03T09:15:00+08:00');
const SAME_DAY_QUOTE_AT = Date.parse('2026-09-03T10:00:00+08:00');
const PREVIOUS_DAY_QUOTE_AT = Date.parse('2026-09-02T15:00:00+08:00');
const NOW = new Date('2026-09-03T10:00:00+08:00');

function sameDayQuote(
  price: number | null,
  state: Quote['state'],
  asOf: number = SAME_DAY_QUOTE_AT,
): Quote {
  return quote(price, state, {
    tradingDate: TRADING_DAY,
    quoteValidSince: SESSION_START,
    asOf,
  });
}

test('calculates market value, floating profit and return percentage', () => {
  assert.deepEqual(calculateHoldingMetrics(holding, quote(1_500)), {
    currency: 'CNY',
    quantity: 100,
    averageCost: 1_490,
    currentPrice: 1_500,
    costValue: 149_000,
    marketValue: 150_000,
    previousValue: 148_000,
    profit: 1_000,
    returnPercent: (1_000 / 149_000) * 100,
    dayProfit: null,
    dayProfitPercent: null,
  });
});

test('continues calculating with closed or stale prices but not missing prices', () => {
  assert.equal(calculateHoldingMetrics(holding, quote(1_500, 'closed'))?.profit, 1_000);
  assert.equal(calculateHoldingMetrics(holding, quote(1_500, 'stale'))?.profit, 1_000);
  assert.equal(calculateHoldingMetrics(holding, quote(1_500, 'error')), undefined);
  assert.equal(calculateHoldingMetrics(holding, quote(null, 'error')), undefined);
  assert.equal(calculateHoldingMetrics(holding, quote(0, 'error')), undefined);
  assert.equal(calculateHoldingMetrics(holding, undefined), undefined);
});

test('summarizes only priced holdings in the requested currency', () => {
  const unavailable: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 200,
    averageCost: 10,
  };
  const summary = summarizeHoldingCurrency(
    'CNY',
    [holding, unavailable],
    (item) => item.id === holding.id ? quote(1_500) : undefined,
  );
  assert.deepEqual(summary, {
    currency: 'CNY',
    itemCount: 2,
    pricedItemCount: 1,
    costValue: 149_000,
    marketValue: 150_000,
    profit: 1_000,
    returnPercent: (1_000 / 149_000) * 100,
    dayProfit: null,
    dayProfitPercent: null,
  });
});

test('computes day profit from a quote that belongs to the current trading day', () => {
  assert.equal(holdingDayChange(sameDayQuote(1_500, 'live'), NOW), 20);
  assert.equal(
    calculateHoldingMetrics(holding, sameDayQuote(1_500, 'live'), NOW)?.dayProfit,
    2_000,
  );
});

test('keeps the last same-day quote when refreshing is overdue', () => {
  assert.equal(holdingDayChange(sameDayQuote(1_500, 'stale'), NOW), 20);
  assert.equal(
    calculateHoldingMetrics(holding, sameDayQuote(1_500, 'stale'), NOW)?.dayProfit,
    2_000,
  );
});

test('keeps day profit once the session is closed for the day', () => {
  assert.equal(holdingDayChange(sameDayQuote(1_500, 'closed'), NOW), 20);
});

test('drops day profit when the cached quote predates the current trading day', () => {
  assert.equal(
    holdingDayChange(sameDayQuote(1_500, 'stale', PREVIOUS_DAY_QUOTE_AT), NOW),
    null,
  );
});

test('drops day profit when the quote belongs to another trading day', () => {
  const previousDay = quote(1_500, 'closed', {
    tradingDate: '2026-09-02',
    quoteValidSince: Date.parse('2026-09-02T09:15:00+08:00'),
    asOf: PREVIOUS_DAY_QUOTE_AT,
  });
  assert.equal(holdingDayChange(previousDay, NOW), null);
});

test('drops day profit when the quote carries no change', () => {
  assert.equal(holdingDayChange(sameDayQuote(null, 'error'), NOW), null);
});

test('summarizes day profit only from holdings with a same-day quote', () => {
  const other: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 200,
    averageCost: 10,
  };
  const summary = summarizeHoldingCurrency(
    'CNY',
    [holding, other],
    (item) => (item.id === holding.id ? sameDayQuote(1_500, 'live') : quote(12, 'stale')),
    NOW,
  );
  assert.equal(summary.dayProfit, 2_000);
  assert.equal(summary.dayProfitPercent, (2_000 / 148_000) * 100);
});

test('reports no day profit when every holding lacks a same-day quote', () => {
  const summary = summarizeHoldingCurrency('CNY', [holding], () => quote(1_500, 'stale'), NOW);
  assert.equal(summary.dayProfit, null);
  assert.equal(summary.dayProfitPercent, null);
});

test('measures day profit percentage against the previous close value', () => {
  const metrics = calculateHoldingMetrics(holding, sameDayQuote(1_500, 'live'), NOW);
  assert.equal(metrics?.previousValue, 148_000);
  assert.equal(metrics?.dayProfit, 2_000);
  assert.equal(metrics?.dayProfitPercent, (2_000 / 148_000) * 100);
});

test('bases the summarized day profit percentage only on same-day holdings', () => {
  const outdated: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 100,
    averageCost: 10,
  };
  const summary = summarizeHoldingCurrency(
    'CNY',
    [holding, outdated],
    (item) => (item.id === holding.id ? sameDayQuote(1_500, 'live') : quote(12, 'stale')),
    NOW,
  );
  assert.equal(summary.dayProfit, 2_000);
  assert.equal(summary.dayProfitPercent, (2_000 / 148_000) * 100);
});

test('defaults to showing every field', () => {
  assert.deepEqual(DEFAULT_HOLDING_DESCRIPTION_FIELDS, {
    quantity: true,
    marketValue: true,
    profit: true,
    dayProfit: true,
  });
});

test('ensureAtLeastOneField keeps market value when all flags are off', () => {
  const empty: HoldingDescriptionFields = {
    quantity: false,
    marketValue: false,
    profit: false,
    dayProfit: false,
  };
  assert.deepEqual(ensureAtLeastOneField(empty), {
    quantity: false,
    marketValue: true,
    profit: false,
    dayProfit: false,
  });
});

test('ensureAtLeastOneField returns the input as is when something is enabled', () => {
  const partial: HoldingDescriptionFields = {
    quantity: true,
    marketValue: false,
    profit: false,
    dayProfit: false,
  };
  assert.deepEqual(ensureAtLeastOneField(partial), partial);
});

test('buildHoldingDescriptionSegments renders every enabled field in order', () => {
  const metrics = calculateHoldingMetrics(holding, sameDayQuote(1_500, 'live'), NOW);
  assert.ok(metrics);
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, DEFAULT_HOLDING_DESCRIPTION_FIELDS),
    ['100 股', '15.00万', '+1,000(+0.67%)', '今日+2,000(+1.35%)'],
  );
});

test('buildHoldingDescriptionSegments omits the quantity segment when disabled', () => {
  const metrics = calculateHoldingMetrics(holding, sameDayQuote(1_500, 'live'), NOW);
  assert.ok(metrics);
  const flags: HoldingDescriptionFields = {
    ...DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    quantity: false,
  };
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, flags),
    ['15.00万', '+1,000(+0.67%)', '今日+2,000(+1.35%)'],
  );
});

test('buildHoldingDescriptionSegments falls back to a dash when day profit is unavailable', () => {
  const metrics = calculateHoldingMetrics(holding, quote(1_500, 'live'), NOW);
  assert.ok(metrics);
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, DEFAULT_HOLDING_DESCRIPTION_FIELDS),
    ['100 股', '15.00万', '+1,000(+0.67%)', '今日—'],
  );
});

test('buildCurrencySummarySegments never includes quantity', () => {
  const summary = summarizeHoldingCurrency('CNY', [holding], (item) =>
    item.id === holding.id ? sameDayQuote(1_500, 'live') : undefined,
    NOW,
  );
  assert.deepEqual(
    buildCurrencySummarySegments(summary, {
      quantity: true,
      marketValue: true,
      profit: true,
      dayProfit: true,
    }),
    ['15.00万', '+1,000(+0.67%)', '今日+2,000(+1.35%)'],
  );
});

test('holdingIconKindOf warns when the quote is missing or errored', () => {
  assert.equal(holdingIconKindOf(undefined, undefined), 'warning');
  assert.equal(holdingIconKindOf(2_000, quote(1_500, 'error')), 'warning');
});

test('holdingIconKindOf refuses to show a direction on stale quotes', () => {
  assert.equal(holdingIconKindOf(2_000, sameDayQuote(1_500, 'stale')), 'stale');
});

test('holdingIconKindOf marks unavailable day profit as neutral', () => {
  assert.equal(holdingIconKindOf(null, quote(1_500, 'live')), 'unavailable');
});

test('holdingIconKindOf follows the day profit direction', () => {
  assert.equal(holdingIconKindOf(2_000, sameDayQuote(1_500, 'live')), 'up');
  assert.equal(holdingIconKindOf(-2_000, sameDayQuote(1_460, 'live')), 'down');
  assert.equal(holdingIconKindOf(0, sameDayQuote(1_480, 'live')), 'flat');
});

test('holdingIconKindOf keeps the direction after the market closes', () => {
  assert.equal(holdingIconKindOf(2_000, sameDayQuote(1_500, 'closed')), 'up');
});

test('holdingIconKindOf ignores floating profit when choosing the direction', () => {
  // 浮动盈亏为正、当日为负：图标必须跟当日走，不能跟浮盈走。
  assert.equal(holdingIconKindOf(-2_000, sameDayQuote(1_460, 'live')), 'down');
});

function sortFixture(
  id: string,
  quantity: number,
  averageCost: number,
): Holding {
  return {
    id,
    symbol: `60000${id}.SH`,
    market: 'CN',
    kind: 'stock',
    name: `持仓${id}`,
    quantity,
    averageCost,
  };
}

function quoteAt(symbol: string, price: number, previousClose: number): Quote {
  return {
    ...quote(price),
    symbol,
    previousClose,
    change: price - previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
    tradingDate: TRADING_DAY,
    quoteValidSince: SESSION_START,
    asOf: SAME_DAY_QUOTE_AT,
  };
}

// 成本与昨收刻意不同，让「浮盈」和「当日盈亏」排出不同的顺序。
const sortList = [sortFixture('1', 100, 5), sortFixture('2', 100, 15), sortFixture('3', 100, 8)];
const sortPrices: Record<string, number> = { '600001.SH': 12, '600002.SH': 13, '600003.SH': 9 };
const sortQuoteOf = (item: Holding): Quote | undefined => {
  const price = sortPrices[item.symbol];
  return price === undefined ? undefined : quoteAt(item.symbol, price, 10);
};

test('sortHoldings keeps the manual order', () => {
  assert.deepEqual(
    sortHoldings(sortList, DEFAULT_HOLDING_SORT, sortQuoteOf, NOW).map((item) => item.id),
    ['1', '2', '3'],
  );
});

test('sortHoldings sorts by floating profit rate in both directions', () => {
  // 1: +140%, 3: +12.5%, 2: -13.3%
  assert.deepEqual(
    sortHoldings(sortList, { key: 'profitPercent', desc: true }, sortQuoteOf, NOW).map((i) => i.id),
    ['1', '3', '2'],
  );
  assert.deepEqual(
    sortHoldings(sortList, { key: 'profitPercent', desc: false }, sortQuoteOf, NOW).map((i) => i.id),
    ['2', '3', '1'],
  );
});

test('sortHoldings sorts by day profit rate and yields a different order', () => {
  // 2: +30%, 1: +20%, 3: -10% —— 与浮盈收益率的 [1,3,2] 明显不同
  assert.deepEqual(
    sortHoldings(sortList, { key: 'dayPercent', desc: true }, sortQuoteOf, NOW).map((i) => i.id),
    ['2', '1', '3'],
  );
});

test('sortHoldings sorts by amount rather than by rate', () => {
  // 数量差异让金额顺序与收益率顺序相反：x 收益率高但金额小。
  const list = [sortFixture('x', 10, 10), sortFixture('y', 1_000, 10)];
  const prices: Record<string, number> = { '60000x.SH': 20, '60000y.SH': 10.5 };
  const quoteOf = (item: Holding): Quote | undefined =>
    quoteAt(item.symbol, prices[item.symbol], 10);
  assert.deepEqual(
    sortHoldings(list, { key: 'profitPercent', desc: true }, quoteOf, NOW).map((i) => i.id),
    ['x', 'y'],
  );
  assert.deepEqual(
    sortHoldings(list, { key: 'profitAmount', desc: true }, quoteOf, NOW).map((i) => i.id),
    ['y', 'x'],
  );
});

test('sortHoldings always puts unpriced holdings last', () => {
  const withMissing = [...sortList, sortFixture('4', 100, 10)];
  assert.deepEqual(
    sortHoldings(withMissing, { key: 'profitPercent', desc: true }, sortQuoteOf, NOW).map((i) => i.id),
    ['1', '3', '2', '4'],
  );
  assert.deepEqual(
    sortHoldings(withMissing, { key: 'profitPercent', desc: false }, sortQuoteOf, NOW).map((i) => i.id),
    ['2', '3', '1', '4'],
  );
});

test('sortHoldings keeps the manual order for equal values', () => {
  const list = [sortFixture('1', 100, 10), sortFixture('2', 100, 10), sortFixture('3', 100, 10)];
  const prices: Record<string, number> = { '600001.SH': 12, '600002.SH': 12, '600003.SH': 12 };
  const quoteOf = (item: Holding): Quote | undefined =>
    quoteAt(item.symbol, prices[item.symbol], 10);
  assert.deepEqual(
    sortHoldings(list, { key: 'profitPercent', desc: true }, quoteOf, NOW).map((i) => i.id),
    ['1', '2', '3'],
  );
});

test('holdingSortLabel describes the key and the direction', () => {
  assert.equal(holdingSortLabel({ key: 'manual', desc: true }), '默认顺序');
  assert.equal(holdingSortLabel({ key: 'dayAmount', desc: true }), '今日盈亏金额（从高到低）');
  assert.equal(holdingSortLabel({ key: 'dayAmount', desc: false }), '今日盈亏金额（从低到高）');
});

function hkHolding(id: string): Holding {
  return {
    id,
    symbol: '00700.HK',
    market: 'HK',
    kind: 'stock',
    name: '腾讯控股',
    quantity: 100,
    averageCost: 400,
  };
}

test('moveHoldingWithinCurrency swaps entries inside one currency', () => {
  const list = [sortFixture('1', 100, 10), sortFixture('2', 100, 10), sortFixture('3', 100, 10)];
  assert.deepEqual(moveHoldingWithinCurrency(list, '2', -1).map((i) => i.id), ['2', '1', '3']);
  assert.deepEqual(moveHoldingWithinCurrency(list, '2', 1).map((i) => i.id), ['1', '3', '2']);
});

test('moveHoldingWithinCurrency ignores moves past the group edge', () => {
  const list = [sortFixture('1', 100, 10), sortFixture('2', 100, 10)];
  assert.deepEqual(moveHoldingWithinCurrency(list, '1', -1).map((i) => i.id), ['1', '2']);
  assert.deepEqual(moveHoldingWithinCurrency(list, '2', 1).map((i) => i.id), ['1', '2']);
});

test('moveHoldingWithinCurrency skips holdings of other currencies', () => {
  // CNY 在索引 0 与 2，HKD 夹在中间：把 3 上移应跨过 HKD 与 1 交换，HKD 位置不变。
  const list = [sortFixture('1', 100, 10), hkHolding('h'), sortFixture('3', 100, 10)];
  assert.deepEqual(moveHoldingWithinCurrency(list, '3', -1).map((i) => i.id), ['3', 'h', '1']);
});

test('moveHoldingWithinCurrency leaves unknown ids untouched', () => {
  const list = [sortFixture('1', 100, 10), sortFixture('2', 100, 10)];
  assert.deepEqual(moveHoldingWithinCurrency(list, 'missing', -1).map((i) => i.id), ['1', '2']);
});

test('buildHoldingDescriptionSegments keeps the sign on negative rates', () => {
  // 现价 1460 低于成本 1490：金额与百分比都应带负号，否则排序后看不出谁在亏。
  const metrics = calculateHoldingMetrics(holding, sameDayQuote(1_460, 'live'), NOW);
  assert.ok(metrics);
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, DEFAULT_HOLDING_DESCRIPTION_FIELDS),
    ['100 股', '14.60万', '-3,000(-2.01%)', '今日-2,000(-1.35%)'],
  );
});
