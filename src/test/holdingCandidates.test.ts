import assert from 'node:assert/strict';
import test from 'node:test';
import type { Market, WatchlistState } from '../domain/models';
import { holdingCandidatesFromWatchlists } from '../domain/holdingCandidates';

function watchlistOf(
  groups: Array<{
    id: string;
    stocks: Array<{ symbol: string; market: Market; name?: string }>;
  }>,
): WatchlistState {
  return {
    version: 1,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.id,
      collapsed: false,
      stocks: group.stocks.map((stock, index) => ({
        id: `${group.id}-${index}`,
        symbol: stock.symbol,
        market: stock.market,
        ...(stock.name !== undefined ? { name: stock.name } : {}),
      })),
    })),
  };
}

test('keeps CN and HK stocks while excluding indices, futures and US listings', () => {
  const stocks = watchlistOf([
    {
      id: 'g1',
      stocks: [
        { symbol: '600519.SH', market: 'CN', name: '贵州茅台' },
        { symbol: '00700.HK', market: 'HK', name: '腾讯控股' },
        { symbol: '000001.SHI', market: 'CN', name: '上证指数' },
        { symbol: '399006.SZI', market: 'CN', name: '创业板指' },
        { symbol: 'AAPL.US', market: 'US', name: 'Apple' },
        { symbol: 'AU0.CNF', market: 'CNF', name: '沪金主连' },
      ],
    },
  ]);
  assert.deepEqual(holdingCandidatesFromWatchlists(stocks, watchlistOf([
    { id: 'fund', stocks: [] },
  ])), [
    { symbol: '600519.SH', market: 'CN', kind: 'stock', name: '贵州茅台' },
    { symbol: '00700.HK', market: 'HK', kind: 'stock', name: '腾讯控股' },
  ]);
});

test('maps fund watchlist entries to fund kind and rejects non-CN funds', () => {
  const funds = watchlistOf([
    {
      id: 'etf',
      stocks: [
        { symbol: '510300.SH', market: 'CN', name: '沪深300ETF' },
        { symbol: '159915.SZ', market: 'CN', name: '创业板ETF' },
        { symbol: '02800.HK', market: 'HK', name: '盈富基金' },
      ],
    },
  ]);
  assert.deepEqual(holdingCandidatesFromWatchlists(watchlistOf([
    { id: 'stock', stocks: [] },
  ]), funds), [
    { symbol: '510300.SH', market: 'CN', kind: 'fund', name: '沪深300ETF' },
    { symbol: '159915.SZ', market: 'CN', kind: 'fund', name: '创业板ETF' },
  ]);
});

test('deduplicates across groups and repositories with stock watchlist first', () => {
  const stocks = watchlistOf([
    {
      id: 'a',
      stocks: [{ symbol: '600519.SH', market: 'CN', name: '贵州茅台' }],
    },
    {
      id: 'b',
      stocks: [{ symbol: '600519.SH', market: 'CN', name: '贵州茅台' }],
    },
  ]);
  const funds = watchlistOf([
    {
      id: 'etf',
      stocks: [
        { symbol: '600519.SH', market: 'CN', name: '贵州茅台' },
        { symbol: '510300.SH', market: 'CN', name: '沪深300ETF' },
      ],
    },
  ]);
  assert.deepEqual(holdingCandidatesFromWatchlists(stocks, funds), [
    { symbol: '600519.SH', market: 'CN', kind: 'stock', name: '贵州茅台' },
    { symbol: '510300.SH', market: 'CN', kind: 'fund', name: '沪深300ETF' },
  ]);
});

test('falls back to the symbol when a watchlist entry has no name', () => {
  const stocks = watchlistOf([
    { id: 'g', stocks: [{ symbol: '601398.SH', market: 'CN' }] },
  ]);
  assert.deepEqual(holdingCandidatesFromWatchlists(stocks, watchlistOf([
    { id: 'fund', stocks: [] },
  ])), [
    { symbol: '601398.SH', market: 'CN', kind: 'stock', name: '601398.SH' },
  ]);
});

test('returns an empty list for empty watchlists', () => {
  assert.deepEqual(
    holdingCandidatesFromWatchlists(
      watchlistOf([{ id: 'stock', stocks: [] }]),
      watchlistOf([{ id: 'fund', stocks: [] }]),
    ),
    [],
  );
});
