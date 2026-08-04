import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedSymbol } from '../domain/models';
import {
  parseTencentFundSearchPayload,
  parseTencentPayload,
  parseTencentSearchPayload,
  parseTencentTimestamp,
  TencentDataProvider,
  toTencentSymbol,
} from '../data/tencentDataProvider';

const A_SHARE: NormalizedSymbol = { symbol: '600519.SH', market: 'CN' };
const HK_SHARE: NormalizedSymbol = { symbol: '00700.HK', market: 'HK' };

function row(name: string, price: string, previousClose: string, asOf: string): string[] {
  const values = Array<string>(60).fill('');
  values[1] = name;
  values[3] = price;
  values[4] = previousClose;
  values[30] = asOf;
  return values;
}

test('maps normalized A-share and Hong Kong symbols to Tencent codes', () => {
  assert.equal(toTencentSymbol(A_SHARE), 'sh600519');
  assert.equal(toTencentSymbol({ symbol: '000001.SZ', market: 'CN' }), 'sz000001');
  assert.equal(toTencentSymbol({ symbol: '430047.BJ', market: 'CN' }), 'bj430047');
  assert.equal(toTencentSymbol(HK_SHARE), 'r_hk00700');
  assert.equal(toTencentSymbol({ symbol: '000001.SHI', market: 'CN' }), 'sh000001');
  assert.equal(toTencentSymbol({ symbol: '399001.SZI', market: 'CN' }), 'sz399001');
  assert.equal(toTencentSymbol({ symbol: 'HSI.HKI', market: 'HK' }), 'r_hkHSI');
});

test('parses Tencent name and abbreviation search results for A-shares and Hong Kong stocks', () => {
  const payload = String.raw`v_hint="sz~000333~\u7f8e\u7684\u96c6\u56e2~mdjt~GP-A^sh~688981~\u4e2d\u82af\u56fd\u9645~zxgj~GP-A-KCB^hk~00300~\u7f8e\u7684\u96c6\u56e2~mdjt~GP^jj~000333~\u957f\u57ce\u7a33\u56fa\u6536\u76ca\u503a\u5238A~ccwgsyzqa~KJ"`;
  assert.deepEqual(parseTencentSearchPayload(payload), [
    {
      symbol: '000333.SZ',
      market: 'CN',
      kind: 'stock',
      name: '美的集团',
      abbreviation: 'mdjt',
    },
    {
      symbol: '688981.SH',
      market: 'CN',
      kind: 'stock',
      name: '中芯国际',
      abbreviation: 'zxgj',
    },
    {
      symbol: '00300.HK',
      market: 'HK',
      kind: 'stock',
      name: '美的集团',
      abbreviation: 'mdjt',
    },
  ]);
});

test('parses mainland and Hong Kong index search results separately from stocks', () => {
  const payload = String.raw`v_hint="sh~000001~\u4e0a\u8bc1\u6307\u6570~szzs~ZS^sz~399001~\u6df1\u8bc1\u6210\u6307~szcz~ZS^hk~HSI~\u6052\u751f\u6307\u6570~hszs~ZS"`;
  assert.deepEqual(parseTencentSearchPayload(payload), [
    {
      symbol: '000001.SHI',
      market: 'CN',
      kind: 'index',
      name: '上证指数',
      abbreviation: 'szzs',
    },
    {
      symbol: '399001.SZI',
      market: 'CN',
      kind: 'index',
      name: '深证成指',
      abbreviation: 'szcz',
    },
    {
      symbol: 'HSI.HKI',
      market: 'HK',
      kind: 'index',
      name: '恒生指数',
      abbreviation: 'hszs',
    },
  ]);
});

test('keeps an index and stock with the same numeric code as separate search results', () => {
  const payload = String.raw`v_hint="sh~000001~\u4e0a\u8bc1\u6307\u6570~szzs~ZS^sz~000001~\u5e73\u5b89\u94f6\u884c~payh~GP-A"`;
  assert.deepEqual(
    parseTencentSearchPayload(payload).map((result) => [result.symbol, result.kind]),
    [
      ['000001.SHI', 'index'],
      ['000001.SZ', 'stock'],
    ],
  );
});

test('deduplicates equivalent index aliases returned with the same name', () => {
  const payload = String.raw`v_hint="sh~000300~\u6caa\u6df1300~hs300~ZS^sz~399300~\u6caa\u6df1300~hs300~ZS"`;
  assert.deepEqual(parseTencentSearchPayload(payload), [
    {
      symbol: '000300.SHI',
      market: 'CN',
      kind: 'index',
      name: '沪深300',
      abbreviation: 'hs300',
    },
  ]);
});

test('returns no stock matches for an empty Tencent search response', () => {
  assert.deepEqual(parseTencentSearchPayload('v_hint=""'), []);
});

test('parses exchange-traded ETFs separately from stocks and off-exchange funds', () => {
  const payload = String.raw`v_hint="sz~159326~\u7535\u7f51\u8bbe\u5907ETF\u534e\u590f~dwsbetfhx~ETF^sh~561380~\u7535\u7f51\u8bbe\u5907ETF\u56fd\u6cf0~dwsbetfgt~ETF^jj~023639~\u56fd\u6cf0A\u80a1\u7535\u7f51\u8bbe\u5907ETF\u8054\u63a5C~gtagdwsbetfljc~KJ"`;
  assert.deepEqual(parseTencentFundSearchPayload(payload), [
    {
      symbol: '159326.SZ',
      market: 'CN',
      kind: 'fund',
      name: '电网设备ETF华夏',
      abbreviation: 'dwsbetfhx',
    },
    {
      symbol: '561380.SH',
      market: 'CN',
      kind: 'fund',
      name: '电网设备ETF国泰',
      abbreviation: 'dwsbetfgt',
    },
  ]);
  assert.deepEqual(parseTencentSearchPayload(payload), []);
});

test('searches domestic ETFs by name through the fund entry point', async () => {
  const provider = new TencentDataProvider({
    fetcher: async () => new Response(
      String.raw`v_hint="sz~159326~\u7535\u7f51\u8bbe\u5907ETF\u534e\u590f~dwsbetfhx~ETF"`,
    ),
  });
  const results = await provider.searchFunds('电网设备ETF');
  assert.equal(results[0]?.symbol, '159326.SZ');
  assert.equal(results[0]?.kind, 'fund');
});

test('parses domestic ETF quotes through the common Tencent quote fields', () => {
  const etfRow = row('电网设备ETF华夏', '1.643', '1.614', '20260804142415');
  etfRow[5] = '1.626';
  etfRow[33] = '1.651';
  etfRow[34] = '1.610';
  etfRow[36] = '5617807';
  etfRow[37] = '91819';
  etfRow[38] = '4.61';
  const quotes = parseTencentPayload(
    { sz159326: etfRow },
    [{ symbol: '159326.SZ', market: 'CN' }],
    new Date('2026-08-04T06:24:20Z'),
  );

  assert.deepEqual(
    quotes.map((quote) => [
      quote.symbol,
      quote.name,
      quote.price,
      quote.previousClose,
      quote.marketState,
    ]),
    [['159326.SZ', '电网设备ETF华夏', 1.643, 1.614, 'open']],
  );
});

test('falls back to a direct quote lookup for a BSE code missing from Tencent search', async () => {
  const quoteRow = row('康美特', '21.24', '20.85', '20260731153759');
  const payload = [...JSON.stringify({ bj920189: quoteRow })]
    .map((character) =>
      character.charCodeAt(0) > 127
        ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
        : character,
    )
    .join('');
  const requested: string[] = [];
  const provider = new TencentDataProvider({
    fetcher: async (input) => {
      const url = String(input);
      requested.push(url);
      return url.includes('smartbox.gtimg.cn')
        ? new Response('v_hint="N";')
        : new Response(payload);
    },
  });

  assert.deepEqual(await provider.searchStocks('920189'), [
    { symbol: '920189.BJ', market: 'CN', kind: 'stock', name: '康美特' },
  ]);
  assert.equal(requested.some((url) => url.includes('q=bj920189')), true);
});

test('backs off quote refreshes after HTTP 403 and recovers on success', async () => {
  let now = new Date('2026-08-03T07:00:00.000Z');
  let responseStatus = 403;
  const quoteRow = row('贵州茅台', '1350.60', '1361.76', '20260803150000');
  const provider = new TencentDataProvider({
    fetcher: async () => responseStatus === 200
      ? new Response(JSON.stringify({ sh600519: quoteRow }))
      : new Response('', { status: responseStatus }),
    now: () => now,
  });

  await assert.rejects(
    provider.fetchQuotes([A_SHARE]),
    /自动刷新将在 2026-08-03T07:15:00\.000Z 后重试/,
  );
  assert.equal(provider.canAutomaticallyRefresh(), false);
  assert.equal(
    provider.getNextAutomaticRetryAt()?.toISOString(),
    '2026-08-03T07:15:00.000Z',
  );

  now = new Date('2026-08-03T07:15:00.000Z');
  await assert.rejects(
    provider.fetchQuotes([A_SHARE]),
    /自动刷新将在 2026-08-03T07:45:00\.000Z 后重试/,
  );

  responseStatus = 200;
  assert.equal((await provider.fetchQuotes([A_SHARE])).length, 1);
  assert.equal(provider.canAutomaticallyRefresh(), true);
  assert.equal(provider.getNextAutomaticRetryAt(), undefined);
});

test('parses Tencent A-share and Hong Kong timestamps as China Standard Time', () => {
  assert.equal(
    parseTencentTimestamp('20260731100530'),
    Date.parse('2026-07-31T10:05:30+08:00'),
  );
  assert.equal(
    parseTencentTimestamp('2026/07/31 10:05:30'),
    Date.parse('2026-07-31T10:05:30+08:00'),
  );
});

test('parses batch quotes and marks current-session data open', () => {
  const payload = {
    sh600519: row('贵州茅台', '1350.60', '1361.76', '20260731100530'),
    r_hk00700: row('腾讯控股', '475.200', '471.800', '2026/07/31 10:05:31'),
  };
  const quotes = parseTencentPayload(
    payload,
    [A_SHARE, HK_SHARE],
    new Date('2026-07-31T02:05:40Z'),
  );
  assert.deepEqual(
    quotes.map((quote) => [quote.symbol, quote.name, quote.price, quote.previousClose, quote.marketState]),
    [
      ['600519.SH', '贵州茅台', 1350.6, 1361.76, 'open'],
      ['00700.HK', '腾讯控股', 475.2, 471.8, 'open'],
    ],
  );
});

test('parses mainland and Hong Kong index quotes with canonical index symbols', () => {
  const mainlandRow = row('上证指数', '3832.26', '3804.69', '20260731140000');
  const hongKongRow = row('恒生指数', '25884.430', '25858.880', '2026/07/31 15:30:00');
  const quotes = parseTencentPayload(
    { sh000001: mainlandRow, r_hkHSI: hongKongRow },
    [
      { symbol: '000001.SHI', market: 'CN' },
      { symbol: 'HSI.HKI', market: 'HK' },
    ],
    new Date('2026-07-31T06:30:10Z'),
  );
  assert.deepEqual(
    quotes.map((quote) => [quote.symbol, quote.name, quote.price, quote.marketState]),
    [
      ['000001.SHI', '上证指数', 3832.26, 'open'],
      ['HSI.HKI', '恒生指数', 25884.43, 'open'],
    ],
  );
});

test('normalizes A-share and Hong Kong trading metrics into common units', () => {
  const aShareRow = row('贵州茅台', '1350.60', '1361.76', '20260731100530');
  aShareRow[5] = '1355.00';
  aShareRow[33] = '1370.00';
  aShareRow[34] = '1340.00';
  aShareRow[36] = '123456';
  aShareRow[37] = '789012.34';
  aShareRow[38] = '1.23';
  aShareRow[39] = '18.50';
  aShareRow[45] = '2000.50';

  const hkShareRow = row('腾讯控股', '475.200', '471.800', '2026/07/31 10:05:31');
  hkShareRow[5] = '472.000';
  hkShareRow[33] = '480.000';
  hkShareRow[34] = '470.000';
  hkShareRow[36] = '31000000';
  hkShareRow[37] = '14690000000';
  hkShareRow[39] = '17.36';
  hkShareRow[45] = '43207.6374';
  hkShareRow[59] = '0.34';

  const quotes = parseTencentPayload(
    { sh600519: aShareRow, r_hk00700: hkShareRow },
    [A_SHARE, HK_SHARE],
    new Date('2026-07-31T02:05:40Z'),
  );

  assert.deepEqual(
    quotes.map((quote) => [
      quote.open,
      quote.high,
      quote.low,
      quote.volume,
      quote.volumeUnit,
      quote.turnoverAmount,
      quote.turnoverRate,
      quote.peTtm,
      quote.totalMarketCap,
    ]),
    [
      [
        '1355.00',
        '1370.00',
        '1340.00',
        '123456',
        'lot',
        7890123400,
        '1.23',
        '18.50',
        200050000000,
      ],
      [
        '472.000',
        '480.000',
        '470.000',
        '31000000',
        'share',
        '14690000000',
        '0.34',
        '17.36',
        4320763740000,
      ],
    ],
  );
});

test('marks after-hours data closed and skips unusable rows', () => {
  const payload = {
    sh600519: row('贵州茅台', '1350.60', '1361.76', '20260731150000'),
    r_hk00700: row('腾讯控股', '0', '471.800', '2026/07/31 16:00:00'),
  };
  const quotes = parseTencentPayload(
    payload,
    [A_SHARE, HK_SHARE],
    new Date('2026-07-31T08:30:00Z'),
  );
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].marketState, 'closed');
});

test('marks exchange holiday quotes closed even inside regular sessions', () => {
  const payload = {
    sh600519: row('贵州茅台', '1350.60', '1361.76', '20261001100530'),
    r_hk00700: row('腾讯控股', '475.200', '471.800', '20261001100531'),
  };
  const quotes = parseTencentPayload(
    payload,
    [A_SHARE, HK_SHARE],
    new Date('2026-10-01T02:05:40Z'),
  );
  assert.deepEqual(
    quotes.map((quote) => quote.marketState),
    ['closed', 'closed'],
  );
});

test('keeps mainland quotes open on a Hong Kong-only holiday', () => {
  const payload = {
    sh600519: row('贵州茅台', '1350.60', '1361.76', '20260525100530'),
    r_hk00700: row('腾讯控股', '475.200', '471.800', '20260525100531'),
  };
  const quotes = parseTencentPayload(
    payload,
    [A_SHARE, HK_SHARE],
    new Date('2026-05-25T02:05:40Z'),
  );
  assert.deepEqual(
    quotes.map((quote) => [quote.symbol, quote.marketState]),
    [
      ['600519.SH', 'open'],
      ['00700.HK', 'closed'],
    ],
  );
});
