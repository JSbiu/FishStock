import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedSymbol } from '../domain/models';
import {
  parseTencentPayload,
  parseTencentSearchPayload,
  parseTencentTimestamp,
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
});

test('parses Tencent name and abbreviation search results for A-shares and Hong Kong stocks', () => {
  const payload = String.raw`v_hint="sz~000333~\u7f8e\u7684\u96c6\u56e2~mdjt~GP-A^hk~00300~\u7f8e\u7684\u96c6\u56e2~mdjt~GP^jj~000333~\u957f\u57ce\u7a33\u56fa\u6536\u76ca\u503a\u5238A~ccwgsyzqa~KJ"`;
  assert.deepEqual(parseTencentSearchPayload(payload), [
    {
      symbol: '000333.SZ',
      market: 'CN',
      name: '美的集团',
      abbreviation: 'mdjt',
    },
    {
      symbol: '00300.HK',
      market: 'HK',
      name: '美的集团',
      abbreviation: 'mdjt',
    },
  ]);
});

test('returns no stock matches for an empty Tencent search response', () => {
  assert.deepEqual(parseTencentSearchPayload('v_hint=""'), []);
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
