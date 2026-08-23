import type { StateStore } from './watchlistRepository';

const STORAGE_KEY = 'fishStock.statusBarDisplay.v1';

export type StatusBarDisplayMode = 'quotes' | 'holdings';

export interface StatusBarDisplayState {
  version: 1;
  mode: StatusBarDisplayMode;
}

export function parseStatusBarDisplayState(value: unknown): StatusBarDisplayState {
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'mode' in value &&
    (value.mode === 'quotes' || value.mode === 'holdings')
  ) {
    return { version: 1, mode: value.mode };
  }
  return { version: 1, mode: 'quotes' };
}

export class StatusBarDisplayStore {
  private state: StatusBarDisplayState | undefined;

  public constructor(private readonly store: StateStore) {}

  public async load(): Promise<StatusBarDisplayState> {
    if (!this.state) {
      this.state = parseStatusBarDisplayState(this.store.get<unknown>(STORAGE_KEY));
    }
    return { ...this.state };
  }

  public getMode(): StatusBarDisplayMode {
    if (!this.state) {
      throw new Error('StatusBarDisplayStore 必须先调用 load()');
    }
    return this.state.mode;
  }

  public async setMode(mode: StatusBarDisplayMode): Promise<void> {
    if (!this.state) {
      throw new Error('StatusBarDisplayStore 必须先调用 load()');
    }
    if (this.state.mode === mode) {
      return;
    }
    this.state = { version: 1, mode };
    await this.store.update(STORAGE_KEY, this.state);
  }
}
