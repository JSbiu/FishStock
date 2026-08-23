import type {
  Holding,
  HoldingSearchResult,
} from './models';

export interface HoldingDraftInput {
  id?: unknown;
  symbol?: unknown;
  quantity?: unknown;
  averageCost?: unknown;
}

export class HoldingDraftValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HoldingDraftValidationError';
  }
}

function readSymbol(value: unknown, rowNumber: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HoldingDraftValidationError(`第 ${rowNumber} 行缺少证券代码`);
  }
  return value.trim();
}

function readQuantity(value: unknown, rowNumber: number): number {
  const parsed = typeof value === 'string' && value.trim()
    ? Number(value.trim())
    : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new HoldingDraftValidationError(`第 ${rowNumber} 行的持有数量必须是正整数`);
  }
  return parsed;
}

function readAverageCost(value: unknown, rowNumber: number): number {
  const parsed = typeof value === 'string' && value.trim()
    ? Number(value.trim())
    : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    throw new HoldingDraftValidationError(`第 ${rowNumber} 行的平均成本必须是大于 0 的数字`);
  }
  return parsed;
}

export function materializeHoldingDraft(
  inputs: readonly HoldingDraftInput[],
  existingHoldings: readonly Holding[],
  allowedNewInstruments: ReadonlyMap<string, HoldingSearchResult>,
  createId: () => string,
): Holding[] {
  const existingById = new Map(existingHoldings.map((holding) => [holding.id, holding]));
  const seenIds = new Set<string>();
  const seenSymbols = new Set<string>();

  return inputs.map((input, index) => {
    const rowNumber = index + 1;
    const symbol = readSymbol(input.symbol, rowNumber);
    const quantity = readQuantity(input.quantity, rowNumber);
    const averageCost = readAverageCost(input.averageCost, rowNumber);
    let holding: Holding;

    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || !input.id.trim()) {
        throw new HoldingDraftValidationError(`第 ${rowNumber} 行的持仓标识无效`);
      }
      const existing = existingById.get(input.id);
      if (!existing || existing.symbol !== symbol) {
        throw new HoldingDraftValidationError(`第 ${rowNumber} 行不是可编辑的现有持仓`);
      }
      holding = { ...existing, quantity, averageCost };
    } else {
      const instrument = allowedNewInstruments.get(symbol);
      if (!instrument) {
        throw new HoldingDraftValidationError(`第 ${rowNumber} 行不是已确认的搜索结果`);
      }
      holding = {
        id: createId(),
        symbol: instrument.symbol,
        market: instrument.market,
        kind: instrument.kind,
        name: instrument.name,
        quantity,
        averageCost,
      };
    }

    if (seenIds.has(holding.id)) {
      throw new HoldingDraftValidationError(`第 ${rowNumber} 行的持仓标识重复`);
    }
    if (seenSymbols.has(holding.symbol)) {
      throw new HoldingDraftValidationError(`第 ${rowNumber} 行的证券已经存在`);
    }
    seenIds.add(holding.id);
    seenSymbols.add(holding.symbol);
    return holding;
  });
}
