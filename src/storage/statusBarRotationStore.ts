import type { StateStore } from './watchlistRepository';

const STORAGE_KEY = 'fishStock.statusBarRotation.v1';

export const STATUS_BAR_GROUP_KINDS = ['stock', 'fund', 'futures'] as const;

export type StatusBarGroupKind = (typeof STATUS_BAR_GROUP_KINDS)[number];

export type StatusBarGroupIds = Record<StatusBarGroupKind, readonly string[]>;

export interface StatusBarRotationState {
  version: 1;
  excluded: Record<StatusBarGroupKind, string[]>;
}

function defaultState(): StatusBarRotationState {
  return {
    version: 1,
    excluded: { stock: [], fund: [], futures: [] },
  };
}

function parseGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseStatusBarRotationState(value: unknown): StatusBarRotationState {
  if (typeof value !== 'object' || value === null || !('excluded' in value)) {
    return defaultState();
  }
  const excluded = (value as { excluded?: unknown }).excluded;
  if (typeof excluded !== 'object' || excluded === null) {
    return defaultState();
  }
  const candidate = excluded as Partial<Record<StatusBarGroupKind, unknown>>;
  return {
    version: 1,
    excluded: {
      stock: parseGroupIds(candidate.stock),
      fund: parseGroupIds(candidate.fund),
      futures: parseGroupIds(candidate.futures),
    },
  };
}

function cloneState(state: StatusBarRotationState): StatusBarRotationState {
  return {
    version: 1,
    excluded: {
      stock: [...state.excluded.stock],
      fund: [...state.excluded.fund],
      futures: [...state.excluded.futures],
    },
  };
}

export class StatusBarRotationStore {
  private state: StatusBarRotationState | undefined;

  public constructor(private readonly store: StateStore) {}

  public async load(): Promise<StatusBarRotationState> {
    if (!this.state) {
      this.state = parseStatusBarRotationState(this.store.get<unknown>(STORAGE_KEY));
    }
    return cloneState(this.state);
  }

  public isGroupIncluded(kind: StatusBarGroupKind, groupId: string): boolean {
    if (!this.state) {
      throw new Error('StatusBarRotationStore 必须先调用 load()');
    }
    return !this.state.excluded[kind].includes(groupId);
  }

  public async setIncludedGroupIds(
    current: StatusBarGroupIds,
    included: StatusBarGroupIds,
  ): Promise<void> {
    if (!this.state) {
      throw new Error('StatusBarRotationStore 必须先调用 load()');
    }
    const excluded = {} as Record<StatusBarGroupKind, string[]>;
    for (const kind of STATUS_BAR_GROUP_KINDS) {
      const includedIds = new Set(included[kind]);
      excluded[kind] = current[kind].filter((groupId) => !includedIds.has(groupId));
    }
    this.state = { version: 1, excluded };
    await this.store.update(STORAGE_KEY, this.state);
  }
}
