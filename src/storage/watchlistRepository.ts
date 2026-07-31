import type { Stock, WatchGroup, WatchlistState } from '../domain/models';
import { moveItem, type MoveDirection } from '../domain/sorting';
import { normalizeSymbol } from '../domain/symbol';

const STORAGE_KEY = 'fishStock.watchlist.v1';

export interface WatchlistRepositoryOptions {
  storageKey?: string;
  createDefault?: () => WatchlistState;
}

export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}
export class WatchlistValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WatchlistValidationError';
  }
}

export function createDefaultWatchlist(): WatchlistState {
  return {
    version: 1,
    groups: [
      {
        id: 'default',
        name: '默认',
        collapsed: false,
        stocks: [
          {
            id: 'sample-cn',
            symbol: '600519.SH',
            market: 'CN',
            name: '贵州茅台',
          },
          {
            id: 'sample-hk',
            symbol: '00700.HK',
            market: 'HK',
            name: '腾讯控股',
          },
        ],
      },
      {
        id: 'indices',
        name: '指数',
        collapsed: false,
        stocks: [
          {
            id: 'sample-shanghai-index',
            symbol: '000001.SHI',
            market: 'CN',
            name: '上证指数',
          },
          {
            id: 'sample-csi-300',
            symbol: '000300.SHI',
            market: 'CN',
            name: '沪深300',
          },
          {
            id: 'sample-chinext-index',
            symbol: '399006.SZI',
            market: 'CN',
            name: '创业板指',
          },
        ],
      },
      {
        id: 'banks',
        name: '银行',
        collapsed: false,
        stocks: [
          {
            id: 'sample-icbc',
            symbol: '601398.SH',
            market: 'CN',
            name: '工商银行',
          },
          {
            id: 'sample-abc',
            symbol: '601288.SH',
            market: 'CN',
            name: '农业银行',
          },
          {
            id: 'sample-boc',
            symbol: '601988.SH',
            market: 'CN',
            name: '中国银行',
          },
          {
            id: 'sample-ccb',
            symbol: '601939.SH',
            market: 'CN',
            name: '建设银行',
          },
          {
            id: 'sample-bocom',
            symbol: '601328.SH',
            market: 'CN',
            name: '交通银行',
          },
          {
            id: 'sample-psbc',
            symbol: '601658.SH',
            market: 'CN',
            name: '邮储银行',
          },
        ],
      },
    ],
  };
}

function createEmptyWatchlist(): WatchlistState {
  return {
    version: 1,
    groups: [
      {
        id: 'default',
        name: '默认',
        collapsed: false,
        stocks: [],
      },
    ],
  };
}

export function createEmptyFuturesWatchlist(): WatchlistState {
  return createEmptyWatchlist();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WatchlistValidationError(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function parseStock(value: unknown, seenIds: Set<string>, seenSymbols: Set<string>): Stock {
  if (!isRecord(value)) {
    throw new WatchlistValidationError('自选条目格式无效');
  }
  const id = readString(value.id, '条目 id');
  if (seenIds.has(id)) {
    throw new WatchlistValidationError(`条目 id 重复：${id}`);
  }
  seenIds.add(id);

  const normalized = normalizeSymbol(readString(value.symbol, '证券代码'));
  if (seenSymbols.has(normalized.symbol)) {
    throw new WatchlistValidationError(`证券代码重复：${normalized.symbol}`);
  }
  seenSymbols.add(normalized.symbol);

  const name = value.name === undefined ? undefined : readString(value.name, '条目名称');
  return { id, symbol: normalized.symbol, market: normalized.market, ...(name ? { name } : {}) };
}

export function parseWatchlistState(value: unknown): WatchlistState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.groups)) {
    throw new WatchlistValidationError('不是 FishStock v1 自选股文件');
  }

  const seenGroupIds = new Set<string>();
  const seenGroupNames = new Set<string>();
  const seenStockIds = new Set<string>();
  const seenSymbols = new Set<string>();
  const groups: WatchGroup[] = value.groups.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.stocks)) {
      throw new WatchlistValidationError('分组格式无效');
    }
    const id = readString(item.id, '分组 id');
    const name = readString(item.name, '分组名称');
    if (seenGroupIds.has(id) || seenGroupNames.has(name)) {
      throw new WatchlistValidationError(`分组重复：${name}`);
    }
    seenGroupIds.add(id);
    seenGroupNames.add(name);
    return {
      id,
      name,
      collapsed: item.collapsed === true,
      stocks: item.stocks.map((stock) => parseStock(stock, seenStockIds, seenSymbols)),
    };
  });

  if (groups.length === 0) {
    throw new WatchlistValidationError('至少需要一个分组');
  }
  return { version: 1, groups };
}

function cloneState(state: WatchlistState): WatchlistState {
  return structuredClone(state);
}

export class WatchlistRepository {
  private state: WatchlistState | undefined;
  private readonly storageKey: string;
  private readonly createDefault: () => WatchlistState;

  public constructor(
    private readonly store: StateStore,
    options: WatchlistRepositoryOptions = {},
  ) {
    this.storageKey = options.storageKey ?? STORAGE_KEY;
    this.createDefault = options.createDefault ?? createDefaultWatchlist;
  }

  public async load(): Promise<WatchlistState> {
    if (this.state) {
      return cloneState(this.state);
    }
    const stored = this.store.get<unknown>(this.storageKey);
    try {
      this.state = stored === undefined ? this.createDefault() : parseWatchlistState(stored);
    } catch {
      this.state = this.createDefault();
    }
    await this.store.update(this.storageKey, this.state);
    return cloneState(this.state);
  }

  public getSnapshot(): WatchlistState {
    if (!this.state) {
      throw new Error('WatchlistRepository 必须先调用 load()');
    }
    return cloneState(this.state);
  }

  public async clear(): Promise<void> {
    await this.save(createEmptyWatchlist());
  }

  public async restoreDefault(): Promise<void> {
    await this.save(this.createDefault());
  }

  public async addGroup(id: string, name: string): Promise<void> {
    const state = this.getSnapshot();
    const cleanName = readString(name, '分组名称');
    if (state.groups.some((group) => group.name === cleanName)) {
      throw new WatchlistValidationError(`分组已存在：${cleanName}`);
    }
    state.groups.push({ id, name: cleanName, collapsed: false, stocks: [] });
    await this.save(state);
  }

  public async renameGroup(groupId: string, name: string): Promise<void> {
    const state = this.getSnapshot();
    const group = this.requireGroup(state, groupId);
    const cleanName = readString(name, '分组名称');
    if (state.groups.some((item) => item.id !== groupId && item.name === cleanName)) {
      throw new WatchlistValidationError(`分组已存在：${cleanName}`);
    }
    group.name = cleanName;
    await this.save(state);
  }

  public async removeGroup(groupId: string): Promise<void> {
    const state = this.getSnapshot();
    if (state.groups.length === 1) {
      throw new WatchlistValidationError('至少保留一个分组');
    }
    this.requireGroup(state, groupId);
    state.groups = state.groups.filter((group) => group.id !== groupId);
    await this.save(state);
  }

  public async setGroupCollapsed(groupId: string, collapsed: boolean): Promise<void> {
    const state = this.getSnapshot();
    this.requireGroup(state, groupId).collapsed = collapsed;
    await this.save(state);
  }

  public async addStock(groupId: string, stock: Stock): Promise<void> {
    const state = this.getSnapshot();
    const normalized = normalizeSymbol(stock.symbol);
    if (state.groups.some((group) => group.stocks.some((item) => item.symbol === normalized.symbol))) {
      throw new WatchlistValidationError(`已添加 ${normalized.symbol}`);
    }
    const group = this.requireGroup(state, groupId);
    group.stocks.push({ ...stock, symbol: normalized.symbol, market: normalized.market });
    await this.save(state);
  }

  public async removeStock(stockId: string): Promise<void> {
    const state = this.getSnapshot();
    const located = this.requireStock(state, stockId);
    located.group.stocks = located.group.stocks.filter((stock) => stock.id !== stockId);
    await this.save(state);
  }

  public async moveStock(stockId: string, direction: MoveDirection): Promise<void> {
    const state = this.getSnapshot();
    const { group, index } = this.requireStock(state, stockId);
    group.stocks = moveItem(group.stocks, index, direction);
    await this.save(state);
  }

  public async moveStockToGroup(stockId: string, targetGroupId: string): Promise<void> {
    const state = this.getSnapshot();
    const { group: source, index } = this.requireStock(state, stockId);
    const target = this.requireGroup(state, targetGroupId);
    if (source.id === target.id) {
      return;
    }
    const [stock] = source.stocks.splice(index, 1);
    target.stocks.push(stock);
    await this.save(state);
  }

  private requireGroup(state: WatchlistState, groupId: string): WatchGroup {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) {
      throw new WatchlistValidationError('分组不存在');
    }
    return group;
  }

  private requireStock(
    state: WatchlistState,
    stockId: string,
  ): { group: WatchGroup; index: number } {
    for (const group of state.groups) {
      const index = group.stocks.findIndex((stock) => stock.id === stockId);
      if (index >= 0) {
        return { group, index };
      }
    }
    throw new WatchlistValidationError('股票不存在');
  }

  private async save(state: WatchlistState): Promise<void> {
    this.state = parseWatchlistState(state);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.update(this.storageKey, this.state);
  }
}
