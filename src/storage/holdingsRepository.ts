// 领域函数与下面仓储的同名方法重名，导入时取别名以免遮蔽。
import { moveHolding as moveHoldingInList } from '../domain/holdings';
import type {
  CashBalance,
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

function readTag(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HoldingsValidationError('持仓标签必须是字符串');
  }
  const tag = value.trim();
  return tag ? tag : undefined;
}

function readCash(value: unknown): CashBalance | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new HoldingsValidationError('现金余额格式无效');
  }
  if (
    typeof value.amount !== 'number' ||
    !Number.isFinite(value.amount) ||
    value.amount < 0
  ) {
    throw new HoldingsValidationError('现金金额必须是大于等于 0 的数字');
  }
  if (value.currency !== 'CNY' && value.currency !== 'HKD') {
    throw new HoldingsValidationError('现金币种无效');
  }
  return {
    amount: value.amount,
    currency: value.currency,
  };
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
  const tag = readTag(value.tag);
  return {
    id,
    symbol: normalized.symbol,
    market: normalized.market,
    kind,
    ...(name ? { name } : {}),
    ...(tag ? { tag } : {}),
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
  const cash = readCash(value.cash);
  return {
    version: 1,
    holdings: value.holdings.map((holding) =>
      parseHolding(holding, seenIds, seenSymbols)),
    ...(cash ? { cash } : {}),
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

  /**
 * 调整手动顺序。只在同币种分组内生效，跨币种调用会原样返回。
 * 走 `save()` 因此沿用整批校验，不会出现半成品顺序。
 */
  public async moveHolding(holdingId: string, delta: -1 | 1): Promise<void> {
    const state = this.getSnapshot();
    this.requireHolding(state, holdingId);
    const next = moveHoldingInList(state.holdings, holdingId, delta);
    await this.save({ ...state, holdings: next });
  }

  public async removeHolding(holdingId: string): Promise<void> {
    const state = this.getSnapshot();
    this.requireHolding(state, holdingId);
    state.holdings = state.holdings.filter((holding) => holding.id !== holdingId);
    await this.save(state);
  }

  public async clear(): Promise<void> {
    const state = this.getSnapshot();
    await this.save({
      version: 1,
      holdings: [],
      ...(state.cash ? { cash: state.cash } : {}),
    });
  }

  public async replaceHoldings(holdings: readonly Holding[]): Promise<void> {
    const state = this.getSnapshot();
    await this.save({
      version: 1,
      holdings: [...holdings],
      ...(state.cash ? { cash: state.cash } : {}),
    });
  }

  /** 持仓与现金属于同一份账户快照，必须在同一次写入中提交。 */
  public async replacePortfolio(
    holdings: readonly Holding[],
    cash: CashBalance,
  ): Promise<void> {
    const normalizedCash = readCash(cash);
    await this.save({
      version: 1,
      holdings: [...holdings],
      ...(normalizedCash && normalizedCash.amount > 0
        ? { cash: normalizedCash }
        : {}),
    });
  }

  private requireHolding(state: HoldingsState, holdingId: string): Holding {
    const holding = state.holdings.find((item) => item.id === holdingId);
    if (!holding) {
      throw new HoldingsValidationError('持仓条目不存在');
    }
    return holding;
  }

  private async save(state: HoldingsState): Promise<void> {
    const parsed = parseHoldingsState(state);
    await this.store.update(STORAGE_KEY, parsed);
    this.state = parsed;
  }

  private async persist(): Promise<void> {
    await this.store.update(STORAGE_KEY, this.state);
  }
}
