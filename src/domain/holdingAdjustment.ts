import type { Holding } from './models';

export type AdjustmentDirection = 'buy' | 'sell';

export interface HoldingAdjustmentInput {
  direction: AdjustmentDirection;
  quantity: number;
  price: number;
}

export interface HoldingAdjustmentResult {
  quantity: number;
  averageCost: number;
  realizedProfit: number;
  cleared: boolean;
}

export class HoldingAdjustmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HoldingAdjustmentError';
  }
}

const COST_PRECISION = 4;
const AMOUNT_PRECISION = 2;

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HoldingAdjustmentError(`${field}必须是正整数`);
  }
  return value;
}

function readPositiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new HoldingAdjustmentError(`${field}必须是大于 0 的数字`);
  }
  return value;
}

export function applyHoldingAdjustment(
  current: Pick<Holding, 'quantity' | 'averageCost'>,
  input: HoldingAdjustmentInput,
): HoldingAdjustmentResult {
  const currentQuantity = readPositiveInteger(current.quantity, '当前持有数量');
  const currentCost = readPositiveNumber(current.averageCost, '当前平均成本');
  const quantity = readPositiveInteger(input.quantity, '变动数量');
  const price = readPositiveNumber(input.price, '成交价');

  if (input.direction === 'buy') {
    const nextQuantity = currentQuantity + quantity;
    if (!Number.isSafeInteger(nextQuantity)) {
      throw new HoldingAdjustmentError('加仓后的持有数量超出可记录范围');
    }
    const costValue = currentQuantity * currentCost + quantity * price;
    const averageCost = roundTo(costValue / nextQuantity, COST_PRECISION);
    if (averageCost <= 0) {
      throw new HoldingAdjustmentError('加仓后的平均成本过小，无法记录');
    }
    return {
      quantity: nextQuantity,
      averageCost,
      realizedProfit: 0,
      cleared: false,
    };
  }

  if (input.direction === 'sell') {
    if (quantity > currentQuantity) {
      throw new HoldingAdjustmentError('卖出数量不能超过当前持有数量');
    }
    const nextQuantity = currentQuantity - quantity;
    return {
      quantity: nextQuantity,
      averageCost: currentCost,
      realizedProfit: roundTo((price - currentCost) * quantity, AMOUNT_PRECISION),
      cleared: nextQuantity === 0,
    };
  }

  throw new HoldingAdjustmentError('调仓方向无效');
}
