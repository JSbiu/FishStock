import assert from 'node:assert/strict';
import test from 'node:test';
import type { WatchlistState } from '../domain/models';
import { formatDiagnosticReport, summarizeWatchlist } from '../domain/diagnostics';

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

test('summarizes watchlist counts without carrying private labels or symbols', () => {
  const summary = summarizeWatchlist(
    state,
    '测试行情源',
    (symbol) => symbol === '600519.SH' ? 'live' : undefined,
    'success',
    '2026-08-03T10:00:00.000Z',
  );
  assert.deepEqual(summary, {
    providerName: '测试行情源',
    groupCount: 1,
    collapsedGroupCount: 1,
    itemCount: 2,
    quoteStates: { live: 1, closed: 0, stale: 0, error: 0, missing: 1 },
    lastRefreshState: 'success',
    lastRefreshAt: '2026-08-03T10:00:00.000Z',
  });
  assert.equal(JSON.stringify(summary).includes('600519'), false);
  assert.equal(JSON.stringify(summary).includes('我的秘密分组'), false);
});

test('formats a copyable diagnostic report with an explicit privacy statement', () => {
  const summary = summarizeWatchlist(state, '测试行情源', () => 'closed', 'not-run');
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
    viewModes: { stock: 'default', futures: 'upOnly' },
    tradingDays: { CN: true, HK: false },
    stock: summary,
    futures: summary,
  });
  assert.match(report, /扩展版本：0\.4\.6/);
  assert.match(report, /CN=交易日, HK=非交易日/);
  assert.match(report, /本报告不包含自选名称、证券代码、文件路径或工作区信息/);
  assert.equal(report.includes('600519'), false);
  assert.equal(report.includes('贵州茅台'), false);
});
