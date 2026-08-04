import type { ViewMode } from '../domain/viewOptions';
import type { StateStore } from './watchlistRepository';

const STORAGE_KEY = 'fishStock.viewOptions.v1';

export type ViewKind = 'stock' | 'fund' | 'futures';

export interface ViewOptionsState {
  version: 1;
  stock: ViewMode;
  fund: ViewMode;
  futures: ViewMode;
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

export function parseViewOptionsState(value: unknown): ViewOptionsState {
  if (typeof value !== 'object' || value === null) {
    return { version: 1, stock: 'default', fund: 'default', futures: 'default' };
  }
  const candidate = value as Partial<ViewOptionsState>;
  return {
    version: 1,
    stock: isViewMode(candidate.stock) ? candidate.stock : 'default',
    fund: isViewMode(candidate.fund) ? candidate.fund : 'default',
    futures: isViewMode(candidate.futures) ? candidate.futures : 'default',
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
}
