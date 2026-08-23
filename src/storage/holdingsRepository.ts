import type {
  Holding,
  HoldingsState,
  HoldingInstrumentKind,
} from '../domain/models';
import { normalizeSymbol } from '../domain/symbol';
import type { StateStore } from './watchlistRepository';

const STORAGE_KEY = 'fishStock.holdings.v1';

export class HoldingsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HoldingsValidationError';
  }
}

function emptyState(): HoldingsState {
  return { version: 1, holdings: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HoldingsValidationError(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function readKind(value: unknown): HoldingInstrumentKind {
  if (value !== 'stock' && value !== 'fund') {
    throw new HoldingsValidationError('持仓品类无效');
  }
  return value;
}

function readQuantity(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new HoldingsValidationError('持有数量必须是正整数');
  }
  return value;
}

function readAverageCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HoldingsValidationError('平均成本必须是大于 0 的数字');
  }
  return value;
}

function parseHolding(
  value: unknown,
  seenIds: Set<string>,
  seenSymbols: Set<string>,
): Holding {
  if (!isRecord(value)) {
    throw new HoldingsValidationError('持仓条目格式无效');
  }
  const id = readString(value.id, '持仓 id');
  if (seenIds.has(id)) {
    throw new HoldingsValidationError(`持仓 id 重复：${id}`);
  }
  seenIds.add(id);

  const normalized = normalizeSymbol(readString(value.symbol, '持仓代码'));
  if (normalized.market !== 'CN' && normalized.market !== 'HK') {
    throw new HoldingsValidationError('持仓仅支持 A 股、港股和境内 ETF');
  }
  if (!/\.(?:SH|SZ|BJ|HK)$/.test(normalized.symbol)) {
    throw new HoldingsValidationError('持仓不支持市场指数或期货');
  }
  if (seenSymbols.has(normalized.symbol)) {
    throw new HoldingsValidationError(`持仓代码重复：${normalized.symbol}`);
  }
  seenSymbols.add(normalized.symbol);

  const kind = readKind(value.kind);
  if (kind === 'fund' && normalized.market !== 'CN') {
    throw new HoldingsValidationError('基金持仓仅支持境内 ETF');
  }
  const name = value.name === undefined
    ? undefined
    : readString(value.name, '持仓名称');
  return {
    id,
    symbol: normalized.symbol,
    market: normalized.market,
    kind,
    ...(name ? { name } : {}),
    quantity: readQuantity(value.quantity),
    averageCost: readAverageCost(value.averageCost),
  };
}

export function parseHoldingsState(value: unknown): HoldingsState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.holdings)) {
    throw new HoldingsValidationError('不是有效的 FishStock v1 持仓数据');
  }
  const seenIds = new Set<string>();
  const seenSymbols = new Set<string>();
  return {
    version: 1,
    holdings: value.holdings.map((holding) =>
      parseHolding(holding, seenIds, seenSymbols)),
  };
}

function cloneState(state: HoldingsState): HoldingsState {
  return structuredClone(state);
}

export class HoldingsRepository {
  private state: HoldingsState | undefined;

  public constructor(private readonly store: StateStore) {}

  public async load(): Promise<HoldingsState> {
    if (this.state) {
      return cloneState(this.state);
    }
    const stored = this.store.get<unknown>(STORAGE_KEY);
    if (stored !== undefined) {
      try {
        this.state = parseHoldingsState(stored);
        return cloneState(this.state);
      } catch {
        // Replace invalid persisted data with the safe empty state below.
      }
    }
    this.state = emptyState();
    await this.persist();
    return cloneState(this.state);
  }

  public getSnapshot(): HoldingsState {
    if (!this.state) {
      throw new Error('HoldingsRepository 必须先调用 load()');
    }
    return cloneState(this.state);
  }

  public async addHolding(holding: Holding): Promise<void> {
    const state = this.getSnapshot();
    if (state.holdings.some((item) => item.symbol === holding.symbol)) {
      throw new HoldingsValidationError(`已添加 ${holding.symbol}`);
    }
    state.holdings.push(holding);
    await this.save(state);
  }

  public async updateHolding(
    holdingId: string,
    quantity: number,
    averageCost: number,
  ): Promise<void> {
    const state = this.getSnapshot();
    const holding = this.requireHolding(state, holdingId);
    holding.quantity = quantity;
    holding.averageCost = averageCost;
    await this.save(state);
  }

  public async removeHolding(holdingId: string): Promise<void> {
    const state = this.getSnapshot();
    this.requireHolding(state, holdingId);
    state.holdings = state.holdings.filter((holding) => holding.id !== holdingId);
    await this.save(state);
  }

  public async clear(): Promise<void> {
    await this.save(emptyState());
  }

  private requireHolding(state: HoldingsState, holdingId: string): Holding {
    const holding = state.holdings.find((item) => item.id === holdingId);
    if (!holding) {
      throw new HoldingsValidationError('持仓条目不存在');
    }
    return holding;
  }

  private async save(state: HoldingsState): Promise<void> {
    this.state = parseHoldingsState(state);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.update(STORAGE_KEY, this.state);
  }
}
