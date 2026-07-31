import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedSymbol } from '../domain/models';
import {
  candidateFutureContracts,
  parseSinaFuturesPayload,
  parseSinaFuturesSuggestions,
  SinaFuturesProvider,
} from '../data/sinaFuturesProvider';

const NOW = new Date('2026-07-31T13:20:00.000Z');
const AL_MAIN: NormalizedSymbol = { symbol: 'AL0.CNF', market: 'CNF' };

function futuresRow(
  code: string,
  name: string,
  price: string,
  tradingDate = '2026-07-31',
): string {
  const row = Array<string>(45).fill('');
  row[0] = name;
  row[1] = '211950';
  row[2] = '23600.000';
  row[3] = '23690.000';
  row[4] = '23550.000';
  row[8] = price;
  row[10] = '23665.000';
  row[13] = '250048';
  row[14] = '21604';
  row[15] = '沪';
  row[16] = '铝';
  row[17] = tradingDate;
  return `var hq_str_nf_${code}="${row.join(',')}";`;
}

test('parses Sina domestic futures suggestions only', () => {
  const payload =
    'var suggestvalue="铝,87,al0,al0,铝,,铝,99,1,,,;沪深300期货,87,if0,if0,沪深300期货,,沪深300期货,99,1,,,;俄铝,31,00486,00486,俄铝,,俄铝,99,1,,,";';
  assert.deepEqual(parseSinaFuturesSuggestions(payload), [
    { symbol: 'AL0.CNF', market: 'CNF', kind: 'future', name: '沪铝主连' },
  ]);
});

test('generates both four-digit and Zhengzhou-style contract candidates', () => {
  const candidates = candidateFutureContracts('AL0.CNF', NOW).map((item) => item.symbol);
  assert.equal(candidates.includes('AL2607.CNF'), true);
  assert.equal(candidates.includes('AL607.CNF'), true);
  assert.equal(candidates.includes('AL2806.CNF'), true);
});

test('parses futures price against previous settlement with volume and open interest', () => {
  const quotes = parseSinaFuturesPayload(futuresRow('AL0', '铝连续', '23680.000'), [AL_MAIN], NOW);
  assert.deepEqual(quotes, [
    {
      symbol: 'AL0.CNF',
      market: 'CNF',
      name: '沪铝主连',
      currency: 'CNY',
      price: 23680,
      previousClose: 23665,
      settlementPrice: 23665,
      open: '23600.000',
      high: '23690.000',
      low: '23550.000',
      openInterest: '250048',
      volume: '21604',
      volumeUnit: 'lot',
      venue: '上海期货交易所',
      asOf: Date.parse('2026-07-31T21:19:50+08:00'),
      marketState: 'open',
    },
  ]);
});

test('searches a Chinese alias and previews only contracts returned by the quote endpoint', async () => {
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('suggest3.sinajs.cn')) {
      return new Response('var suggestvalue="铝,87,al0,al0,铝,,铝,99,1,,,";');
    }
    return new Response(
      [
        futuresRow('AL0', '铝连续', '23680.000'),
        futuresRow('AL2607', '铝2607', '23500.000', '2026-07-15'),
        futuresRow('AL2608', '铝2608', '23655.000'),
        futuresRow('AL2609', '铝2609', '23620.000'),
      ].join('\n'),
    );
  };
  const provider = new SinaFuturesProvider({
    fetcher,
    now: () => NOW,
    decode: (bytes) => new TextDecoder().decode(bytes),
  });

  const results = await provider.searchFutures('电解铝主连');
  assert.deepEqual(
    results.map((item) => [item.symbol, item.name]),
    [
      ['AL0.CNF', '沪铝主连'],
      ['AL2608.CNF', '铝2608'],
      ['AL2609.CNF', '铝2609'],
    ],
  );
  assert.equal(requestedUrls[0].includes(encodeURIComponent('沪铝')), true);
});

test('accepts an active month code and rejects an expired contract with stale trading date', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      [
        futuresRow('AL0', '铝连续', '23680.000'),
        futuresRow('AL2607', '铝2607', '23500.000', '2026-07-15'),
        futuresRow('AL2608', '铝2608', '23655.000'),
      ].join('\n'),
    );
  const provider = new SinaFuturesProvider({
    fetcher,
    now: () => NOW,
    decode: (bytes) => new TextDecoder().decode(bytes),
  });

  assert.deepEqual(
    (await provider.searchFutures('AL2608')).map((item) => item.symbol),
    ['AL2608.CNF'],
  );
  assert.deepEqual(await provider.searchFutures('AL2607'), []);
});
