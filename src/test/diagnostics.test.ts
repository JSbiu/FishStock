import assert from 'node:assert/strict';
import test from 'node:test';
import type { HoldingsState, WatchlistState } from '../domain/models';
import {
  formatDiagnosticReport,
  summarizeHoldings,
  summarizeWatchlist,
} from '../domain/diagnostics';

const state: WatchlistState = {
  version: 1,
  groups: [
    {
      id: 'private-group',
      name: '我的秘密分组',
      collapsed: true,
      stocks: [
        { id: 'one', symbol: '600519.SH', market: 'CN', name: '贵州茅台' },
        { id: 'two', symbol: '00700.HK', market: 'HK', name: '腾讯控股' },
      ],
    },
  ],
};

const holdings: HoldingsState = {
  version: 1,
  holdings: [
    {
      id: 'holding-one',
      symbol: '600519.SH',
      market: 'CN',
      kind: 'stock',
      name: '贵州茅台',
      quantity: 100,
      averageCost: 1_490,
    },
  ],
};

test('summarizes watchlist counts without carrying private labels or symbols', () => {
  const summary = summarizeWatchlist(
    state,
    '测试行情源',
    (symbol) => symbol === '600519.SH' ? { state: 'live' } : undefined,
    'success',
    '2026-08-03T10:00:00.000Z',
  );
  assert.deepEqual(summary, {
    providerName: '测试行情源',
    groupCount: 1,
    collapsedGroupCount: 1,
    itemCount: 2,
    quoteStates: { live: 1, closed: 0, stale: 0, error: 0, missing: 1 },
    staleReasons: {
      'refresh-overdue': 0,
      'quote-not-current': 0,
      'future-timestamp': 0,
      'session-uncovered': 0,
      unspecified: 0,
    },
    lastRefreshState: 'success',
    lastRefreshAt: '2026-08-03T10:00:00.000Z',
  });
  assert.equal(JSON.stringify(summary).includes('600519'), false);
  assert.equal(JSON.stringify(summary).includes('我的秘密分组'), false);
});

test('formats a copyable diagnostic report with an explicit privacy statement', () => {
  const summary = summarizeWatchlist(
    state,
    '测试行情源',
    (symbol) => symbol === '600519.SH'
      ? { state: 'stale', staleReason: 'refresh-overdue' }
      : { state: 'stale', staleReason: 'quote-not-current' },
    'error',
    '2026-08-03T10:00:00.000Z',
    '2026-08-03T10:15:00.000Z',
  );
  const report = formatDiagnosticReport({
    generatedAt: '2026-08-03T10:00:00.000Z',
    extensionVersion: '0.4.6',
    vscodeVersion: '1.90.0',
    platform: 'win32-x64',
    config: {
      refreshIntervalSeconds: 60,
      staleAfterSeconds: 120,
      rotationSeconds: 5,
      colorConvention: 'china',
    },
    viewModes: { stock: 'default', fund: 'gainDesc', futures: 'upOnly' },
    statusBarMode: 'holdings',
    tradingDays: { CN: true, HK: false },
    sessionPhases: { trading: 1, break: 1, closed: 0, unknown: 0 },
    nextAutomaticRefreshAt: '2026-08-03T10:01:00.000Z',
    calendarCoverage: { CN: '2026-12-31', HK: '2026-12-31' },
    futuresSessionRules: { supportedProductCount: 64, uncoveredItemCount: 1 },
    stock: summary,
    fund: summary,
    futures: summary,
    holdings: summarizeHoldings(holdings, () => ({ state: 'closed' })),
  });
  assert.match(report, /扩展版本：0\.4\.6/);
  assert.match(report, /CN=交易日, HK=非交易日/);
  assert.match(report, /trading=1, break=1, closed=0, unknown=0/);
  assert.match(report, /下次计划自动刷新：2026-08-03T10:01:00\.000Z/);
  assert.match(report, /CN 至 2026-12-31, HK 至 2026-12-31/);
  assert.match(report, /已收录 64 个品种，未覆盖自选 1 个/);
  assert.match(report, /Stock=default, Fund=gainDesc, Futures=upOnly/);
  assert.match(report, /状态栏模式：holdings/);
  assert.match(report, /Fund:/);
  assert.match(report, /refresh-overdue=1, quote-not-current=1/);
  assert.match(report, /下次自动探测：2026-08-03T10:15:00\.000Z/);
  assert.match(report, /手动刷新可立即探测/);
  assert.match(report, /Holdings:/);
  assert.match(report, /CNY=1, HKD=0/);
  assert.match(report, /不包含自选名称、证券代码、持仓数量、成本、盈亏/);
  assert.equal(report.includes('600519'), false);
  assert.equal(report.includes('贵州茅台'), false);
  assert.equal(report.includes('1490'), false);
});

test('summarizes holdings without carrying position values or symbols', () => {
  const summary = summarizeHoldings(holdings, () => ({ state: 'live' }));
  assert.deepEqual(summary, {
    itemCount: 1,
    currencies: { CNY: 1, HKD: 0 },
    quoteStates: { live: 1, closed: 0, stale: 0, error: 0, missing: 0 },
  });
  assert.equal(JSON.stringify(summary).includes('600519'), false);
  assert.equal(JSON.stringify(summary).includes('1490'), false);
});
