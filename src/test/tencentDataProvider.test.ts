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
  const values = Array<string>(31).fill('');
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
