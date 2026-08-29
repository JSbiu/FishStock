import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHoldingAdjustment,
  HoldingAdjustmentError,
} from '../domain/holdingAdjustment';

const base = { quantity: 1_000, averageCost: 10.5 };

test('averages cost up when buying above the current cost', () => {
  const result = applyHoldingAdjustment(base, {
    direction: 'buy',
    quantity: 500,
    price: 11.2,
  });

  assert.deepEqual(result, {
    quantity: 1_500,
    averageCost: 10.7333,
    realizedProfit: 0,
    cleared: false,
  });
});

test('averages cost down when buying below the current cost', () => {
  const result = applyHoldingAdjustment(base, {
    direction: 'buy',
    quantity: 1_000,
    price: 9.5,
  });

  assert.deepEqual(result, {
    quantity: 2_000,
    averageCost: 10,
    realizedProfit: 0,
    cleared: false,
  });
});

test('keeps the average cost untouched when selling part of a holding', () => {
  const result = applyHoldingAdjustment(base, {
    direction: 'sell',
    quantity: 500,
    price: 11.2,
  });

  assert.deepEqual(result, {
    quantity: 500,
    averageCost: 10.5,
    realizedProfit: 350,
    cleared: false,
  });
});

test('reports a loss as realized profit without changing the average cost', () => {
  const result = applyHoldingAdjustment(base, {
    direction: 'sell',
    quantity: 200,
    price: 9,
  });

  assert.equal(result.quantity, 800);
  assert.equal(result.averageCost, 10.5);
  assert.equal(result.realizedProfit, -300);
  assert.equal(result.cleared, false);
});

test('marks the holding as cleared when selling everything', () => {
  const result = applyHoldingAdjustment(base, {
    direction: 'sell',
    quantity: 1_000,
    price: 12,
  });

  assert.deepEqual(result, {
    quantity: 0,
    averageCost: 10.5,
    realizedProfit: 1_500,
    cleared: true,
  });
});

test('rounds the averaged cost to four decimal places', () => {
  const result = applyHoldingAdjustment({ quantity: 100, averageCost: 3 }, {
    direction: 'buy',
    quantity: 1,
    price: 3.01,
  });

  assert.equal(result.averageCost, 3.0001);
});

test('rejects selling more than the held quantity', () => {
  assert.throws(
    () => applyHoldingAdjustment(base, {
      direction: 'sell',
      quantity: 1_001,
      price: 11,
    }),
    /卖出数量不能超过当前持有数量/,
  );
});

test('rejects invalid adjustment quantity and price', () => {
  assert.throws(
    () => applyHoldingAdjustment(base, { direction: 'buy', quantity: 0, price: 10 }),
    /变动数量必须是正整数/,
  );
  assert.throws(
    () => applyHoldingAdjustment(base, { direction: 'buy', quantity: -5, price: 10 }),
    /变动数量必须是正整数/,
  );
  assert.throws(
    () => applyHoldingAdjustment(base, { direction: 'buy', quantity: 1.5, price: 10 }),
    /变动数量必须是正整数/,
  );
  assert.throws(
    () => applyHoldingAdjustment(base, { direction: 'buy', quantity: 1, price: 0 }),
    /成交价必须是大于 0 的数字/,
  );
  assert.throws(
    () => applyHoldingAdjustment(base, { direction: 'buy', quantity: 1, price: -2 }),
    /成交价必须是大于 0 的数字/,
  );
  assert.throws(
    () => applyHoldingAdjustment(base, { direction: 'buy', quantity: 1, price: Infinity }),
    /成交价必须是大于 0 的数字/,
  );
});

test('rejects adjusting a draft row that has no valid quantity or cost yet', () => {
  assert.throws(
    () => applyHoldingAdjustment(
      { quantity: Number.NaN, averageCost: 10 },
      { direction: 'buy', quantity: 100, price: 10 },
    ),
    /当前持有数量必须是正整数/,
  );
  assert.throws(
    () => applyHoldingAdjustment(
      { quantity: 100, averageCost: Number.NaN },
      { direction: 'buy', quantity: 100, price: 10 },
    ),
    /当前平均成本必须是大于 0 的数字/,
  );
});

test('rejects an unknown direction and an overflowing quantity', () => {
  assert.throws(
    () => applyHoldingAdjustment(base, {
      direction: 'hold' as unknown as 'buy',
      quantity: 100,
      price: 10,
    }),
    /调仓方向无效/,
  );
  assert.throws(
    () => applyHoldingAdjustment(base, {
      direction: 'buy',
      quantity: Number.MAX_SAFE_INTEGER,
      price: 10,
    }),
    HoldingAdjustmentError,
  );
});
