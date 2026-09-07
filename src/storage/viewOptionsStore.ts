import type { ViewMode } from '../domain/viewOptions';
import {
  DEFAULT_HOLDING_SORT,
  type HoldingSortKey,
  type HoldingSortState,
} from '../domain/holdings';
import type { StateStore } from './watchlistRepository';

const STORAGE_KEY = 'fishStock.viewOptions.v1';

/** 持仓的排序是「维度 + 升降序」两维，不再复用自选的单一 mode，因此不在此列。 */
export type ViewKind = 'stock' | 'fund' | 'futures';

export interface ViewOptionsState {
  version: 1;
  stock: ViewMode;
  fund: ViewMode;
  futures: ViewMode;
  holdingsSort: HoldingSortKey;
  holdingsSortDesc: boolean;
}

function isViewMode(value: unknown): value is ViewMode {
  return (
    value === 'default' ||
    value === 'gainDesc' ||
    value === 'lossDesc' ||
    value === 'upOnly' ||
    value === 'downOnly'
  );
}

function isHoldingSortKey(value: unknown): value is HoldingSortKey {
  return (
    value === 'manual' ||
    value === 'profitPercent' ||
    value === 'profitAmount' ||
    value === 'dayPercent' ||
    value === 'dayAmount'
  );
}

function defaultState(): ViewOptionsState {
  return {
    version: 1,
    stock: 'default',
    fund: 'default',
    futures: 'default',
    holdingsSort: DEFAULT_HOLDING_SORT.key,
    holdingsSortDesc: DEFAULT_HOLDING_SORT.desc,
  };
}

export function parseViewOptionsState(value: unknown): ViewOptionsState {
  if (typeof value !== 'object' || value === null) {
    return defaultState();
  }
  const candidate = value as Partial<ViewOptionsState>;
  return {
    version: 1,
    stock: isViewMode(candidate.stock) ? candidate.stock : 'default',
    fund: isViewMode(candidate.fund) ? candidate.fund : 'default',
    futures: isViewMode(candidate.futures) ? candidate.futures : 'default',
    // 旧版本只存过 holdings 这一个 mode 字段，这里缺字段即回退默认顺序，无需迁移。
    holdingsSort: isHoldingSortKey(candidate.holdingsSort)
      ? candidate.holdingsSort
      : DEFAULT_HOLDING_SORT.key,
    holdingsSortDesc: typeof candidate.holdingsSortDesc === 'boolean'
      ? candidate.holdingsSortDesc
      : DEFAULT_HOLDING_SORT.desc,
  };
}

export class ViewOptionsStore {
  private state: ViewOptionsState | undefined;

  public constructor(private readonly store: StateStore) {}

  public async load(): Promise<ViewOptionsState> {
    if (this.state) {
      return this.state;
    }
    this.state = parseViewOptionsState(this.store.get<unknown>(STORAGE_KEY));
    return this.state;
  }

  public getSnapshot(): ViewOptionsState {
    if (!this.state) {
      throw new Error('ViewOptionsStore 必须先调用 load()');
    }
    return { ...this.state };
  }

  public async setViewMode(kind: ViewKind, mode: ViewMode): Promise<void> {
    const state = this.getSnapshot();
    state[kind] = mode;
    this.state = state;
    await this.store.update(STORAGE_KEY, this.state);
  }

  public async setHoldingSort(sort: HoldingSortState): Promise<void> {
    const state = this.getSnapshot();
    state.holdingsSort = sort.key;
    state.holdingsSortDesc = sort.desc;
    this.state = state;
    await this.store.update(STORAGE_KEY, this.state);
  }
}
