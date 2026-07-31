import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedSymbol } from '../domain/models';
import {
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
