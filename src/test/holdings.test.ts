import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSummarySegments,
  buildHoldingDescriptionSegments,
  calculateHoldingMetrics,
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_SORT,
  ensureAtLeastOneField,
  holdingDayChange,
  holdingIconKindOf,
  holdingSortLabel,
  moveHolding,
  sortHoldings,
  summarizeHoldings,
  toDisplayAmount,
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

test('summarizes only priced holdings', () => {
  const unavailable: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 200,
    averageCost: 10,
  };
  const summary = summarizeHoldings(
    [holding, unavailable],
    (item) => item.id === holding.id ? quote(1_500) : undefined,
  );
  assert.deepEqual(summary, {
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
  const summary = summarizeHoldings(
    [holding, other],
    (item) => (item.id === holding.id ? sameDayQuote(1_500, 'live') : quote(12, 'stale')),
    NOW,
  );
  assert.equal(summary.dayProfit, 2_000);
  assert.equal(summary.dayProfitPercent, (2_000 / 148_000) * 100);
});

test('reports no day profit when every holding lacks a same-day quote', () => {
  const summary = summarizeHoldings([holding], () => quote(1_500, 'stale'), NOW);
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
  const summary = summarizeHoldings(
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
    buildHoldingDescriptionSegments(holding, metrics, { fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS }),
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
    buildHoldingDescriptionSegments(holding, metrics, { fields: flags }),
    ['15.00万', '+1,000(+0.67%)', '今日+2,000(+1.35%)'],
  );
});

test('buildHoldingDescriptionSegments falls back to a dash when day profit is unavailable', () => {
  const metrics = calculateHoldingMetrics(holding, quote(1_500, 'live'), NOW);
  assert.ok(metrics);
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, { fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS }),
    ['100 股', '15.00万', '+1,000(+0.67%)', '今日—'],
  );
});

test('buildCurrencySummarySegments never includes quantity', () => {
  const summary = summarizeHoldings([holding], (item) =>
    item.id === holding.id ? sameDayQuote(1_500, 'live') : undefined,
    NOW,
  );
  assert.deepEqual(
    buildSummarySegments(summary, {
      fields: {
        quantity: true,
        marketValue: true,
        profit: true,
        dayProfit: true,
      },
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
  assert.deepEqual(moveHolding(list, '2', -1).map((i) => i.id), ['2', '1', '3']);
  assert.deepEqual(moveHolding(list, '2', 1).map((i) => i.id), ['1', '3', '2']);
});

test('moveHoldingWithinCurrency ignores moves past the group edge', () => {
  const list = [sortFixture('1', 100, 10), sortFixture('2', 100, 10)];
  assert.deepEqual(moveHolding(list, '1', -1).map((i) => i.id), ['1', '2']);
  assert.deepEqual(moveHolding(list, '2', 1).map((i) => i.id), ['1', '2']);
});

test('moveHolding swaps across currencies now that grouping is gone', () => {
  // 合并展示后没有分组，3 上移会与相邻的港币条目直接交换。
  const list = [sortFixture('1', 100, 10), hkHolding('h'), sortFixture('3', 100, 10)];
  assert.deepEqual(moveHolding(list, '3', -1).map((i) => i.id), ['1', '3', 'h']);
});

test('moveHolding leaves unknown ids untouched', () => {
  const list = [sortFixture('1', 100, 10), sortFixture('2', 100, 10)];
  assert.deepEqual(moveHolding(list, 'missing', -1).map((i) => i.id), ['1', '2']);
});

test('toDisplayAmount only converts HKD and only with a rate', () => {
  // 100 * 0.8557 在浮点下不是精确的 85.57，用容差比对。
  assert.ok(Math.abs(toDisplayAmount(100, 'HKD', 0.8557) - 85.57) < 1e-6);
  assert.equal(toDisplayAmount(100, 'HKD', null), 100);
  assert.equal(toDisplayAmount(100, 'CNY', 0.8557), 100);
});

test('buildHoldingDescriptionSegments converts HKD amounts but not rates', () => {
  // 100 股 × 420 港币，成本 400，昨收 400：市值 42,000 港币、盈亏 +2,000 港币、+5.00%
  const hkQuote = { ...quoteAt('00700.HK', 420, 400), market: 'HK' as const };
  const metrics = calculateHoldingMetrics(hkHolding('h'), hkQuote, NOW);
  assert.ok(metrics);
  assert.equal(metrics.currency, 'HKD');
  assert.deepEqual(
    buildHoldingDescriptionSegments(hkHolding('h'), metrics, {
      fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS,
      hkdRate: 0.8557,
    }),
    ['100 股', '3.59万', '+1,711(+5.00%)', '今日+1,711(+5.00%)'],
  );
  // 折算前后百分比必须一致：汇率在分子分母里约掉了。
  assert.deepEqual(
    buildHoldingDescriptionSegments(hkHolding('h'), metrics, {
      fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS,
      hkdRate: null,
    }),
    ['100 股', '4.20万', '+2,000(+5.00%)', '今日+2,000(+5.00%)'],
  );
});

test('summarizeHoldings folds the HKD position into the CNY total', () => {
  const hkQuote = { ...quoteAt('00700.HK', 420, 400), market: 'HK' as const };
  const converted = summarizeHoldings([hkHolding('h')], () => hkQuote, NOW, 0.8557);
  assert.deepEqual(
    buildSummarySegments(converted, { fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS }),
    ['3.59万', '+1,711(+5.00%)', '今日+1,711(+5.00%)'],
  );
  // 不折算时保持港币原值；百分比两种情况都一致。
  const raw = summarizeHoldings([hkHolding('h')], () => hkQuote, NOW, null);
  assert.deepEqual(
    buildSummarySegments(raw, { fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS }),
    ['4.20万', '+2,000(+5.00%)', '今日+2,000(+5.00%)'],
  );
});

test('treats a suspended quote as having no day profit', () => {
  // 停牌时昨收与最新价相同，若照常计算会得出"今日 0"，被误读成不涨不跌。
  const suspended = { ...sameDayQuote(1_500, 'live'), suspended: true };
  assert.equal(holdingDayChange(suspended, NOW), null);
  assert.equal(calculateHoldingMetrics(holding, suspended, NOW)?.dayProfit, null);
});

test('marks suspended quotes in the icon kind, ahead of stale', () => {
  assert.equal(
    holdingIconKindOf(2_000, { ...sameDayQuote(1_500, 'live'), suspended: true }),
    'suspended',
  );
  // 停牌是确定事实，优先于"数据可能过期"。
  assert.equal(
    holdingIconKindOf(2_000, { ...sameDayQuote(1_500, 'stale'), suspended: true }),
    'suspended',
  );
});

test('buildHoldingDescriptionSegments shows 停牌 in place of the day cell', () => {
  const suspended = { ...sameDayQuote(1_500, 'live'), suspended: true };
  const metrics = calculateHoldingMetrics(holding, suspended, NOW);
  assert.ok(metrics);
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, {
      fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS,
      suspended: true,
    }),
    ['100 股', '15.00万', '+1,000(+0.67%)', '停牌'],
  );
});

test('sortHoldings compares amounts across currencies only after conversion', () => {
  // 人民币 +2,600；港币 100 股 × (430 - 400) = +3,000 HKD。
  // 不折算时 3,000 > 2,600，港币在前；折 0.8557 后变成 2,567 < 2,600，顺序应当翻转
  // ——顺序相反才说明折算确实参与了比较，否则这个测试两种配置都会通过。
  const cny = sortFixture('c', 1_000, 10);
  const hkd = hkHolding('h');
  const quotes: Record<string, Quote> = {
    '60000c.SH': quoteAt('60000c.SH', 12.6, 10),
    '00700.HK': { ...quoteAt('00700.HK', 430, 400), market: 'HK' as const },
  };
  const quoteOf = (item: Holding): Quote | undefined => quotes[item.symbol];
  const desc = (rate: number | null): string[] =>
    sortHoldings([hkd, cny], { key: 'profitAmount', desc: true }, quoteOf, NOW, rate)
      .map((item) => item.id);
  assert.deepEqual(desc(null), ['h', 'c']);
  assert.deepEqual(desc(0.8557), ['c', 'h']);
  // 换成收益率维度则与汇率无关：c 是 26%、h 是 7.5%，两种配置下顺序一致。
  const byRate = (rate: number | null): string[] =>
    sortHoldings([hkd, cny], { key: 'profitPercent', desc: true }, quoteOf, NOW, rate)
      .map((item) => item.id);
  assert.deepEqual(byRate(null), ['c', 'h']);
  assert.deepEqual(byRate(0.8557), ['c', 'h']);
});

test('buildHoldingDescriptionSegments keeps the sign on negative rates', () => {
  // 现价 1460 低于成本 1490：金额与百分比都应带负号，否则排序后看不出谁在亏。
  const metrics = calculateHoldingMetrics(holding, sameDayQuote(1_460, 'live'), NOW);
  assert.ok(metrics);
  assert.deepEqual(
    buildHoldingDescriptionSegments(holding, metrics, { fields: DEFAULT_HOLDING_DESCRIPTION_FIELDS }),
    ['100 股', '14.60万', '-3,000(-2.01%)', '今日-2,000(-1.35%)'],
  );
});
