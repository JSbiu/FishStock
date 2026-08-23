import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HoldingDraftValidationError,
  materializeHoldingDraft,
} from '../domain/holdingDraft';
import type {
  Holding,
  HoldingSearchResult,
} from '../domain/models';

const existing: Holding = {
  id: 'existing',
  symbol: '600519.SH',
  market: 'CN',
  kind: 'stock',
  name: '贵州茅台',
  quantity: 100,
  averageCost: 1_490,
};

const fund: HoldingSearchResult = {
  symbol: '510300.SH',
  market: 'CN',
  kind: 'fund',
  name: '沪深300ETF',
};

test('materializes multiple edits and additions as one validated holdings list', () => {
  const result = materializeHoldingDraft(
    [
      {
        id: existing.id,
        symbol: existing.symbol,
        quantity: '120',
        averageCost: '1480.5',
      },
      {
        symbol: fund.symbol,
        quantity: '1000',
        averageCost: '3.82',
      },
    ],
    [existing],
    new Map([[fund.symbol, fund]]),
    () => 'new-id',
  );

  assert.deepEqual(result, [
    { ...existing, quantity: 120, averageCost: 1_480.5 },
    {
      id: 'new-id',
      symbol: fund.symbol,
      market: fund.market,
      kind: fund.kind,
      name: fund.name,
      quantity: 1_000,
      averageCost: 3.82,
    },
  ]);
});

test('rejects the whole draft when any row is incomplete or duplicated', () => {
  assert.throws(
    () => materializeHoldingDraft(
      [
        {
          id: existing.id,
          symbol: existing.symbol,
          quantity: 120,
          averageCost: 1_480,
        },
        {
          symbol: fund.symbol,
          quantity: '',
          averageCost: 3.82,
        },
      ],
      [existing],
      new Map([[fund.symbol, fund]]),
      () => 'new-id',
    ),
    /第 2 行的持有数量/,
  );
  assert.throws(
    () => materializeHoldingDraft(
      [
        {
          id: existing.id,
          symbol: existing.symbol,
          quantity: 120,
          averageCost: 1_480,
        },
        {
          symbol: existing.symbol,
          quantity: 1,
          averageCost: 1,
        },
      ],
      [existing],
      new Map([[existing.symbol, { ...fund, symbol: existing.symbol }]]),
      () => 'new-id',
    ),
    /第 2 行的证券已经存在/,
  );
});

test('only accepts existing rows or instruments confirmed by search', () => {
  assert.throws(
    () => materializeHoldingDraft(
      [{ symbol: '00700.HK', quantity: 100, averageCost: 400 }],
      [existing],
      new Map(),
      () => 'new-id',
    ),
    HoldingDraftValidationError,
  );
  assert.throws(
    () => materializeHoldingDraft(
      [{ id: existing.id, symbol: '000001.SZ', quantity: 100, averageCost: 10 }],
      [existing],
      new Map(),
      () => 'unused',
    ),
    /不是可编辑的现有持仓/,
  );
});
