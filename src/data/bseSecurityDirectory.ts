import type { StockSearchResult } from '../domain/models';
import builtInSnapshot from './bseSecurities.json';

const BSE_DIRECTORY_URL = 'https://www.bse.cn/service/code_mapping.html';
const CACHE_KEY = 'fishStock.bseSecurityDirectory.v2';
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const FAILED_RETRY_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_RESULT_LIMIT = 20;

export interface SecurityDirectoryCache {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface BseSecurityEntry {
  symbol: string;
  name: string;
  legacySymbol: string;
}

interface CachedBseDirectory {
  version: 2;
  fetchedAt: number;
  lastAttemptAt: number;
  entries: BseSecurityEntry[];
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseBseSecurityDirectoryHtml(html: string): BseSecurityEntry[] {
  const entries: BseSecurityEntry[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      decodeHtml(cell[1]),
    );
    if (cells.length !== 5) {
      continue;
    }
    const name = cells[1];
    const legacySymbol = cells[3];
    const symbol = cells[4];
    if (!name || !/^\d{6}$/.test(legacySymbol) || !/^920\d{3}$/.test(symbol)) {
      continue;
    }
    if (seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    entries.push({ symbol, name, legacySymbol });
  }
  if (entries.length === 0) {
    throw new Error('北交所证券名录响应中没有有效股票');
  }
  return entries;
}

function isBseSecurityEntry(value: unknown): value is BseSecurityEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<BseSecurityEntry>;
  return (
    typeof entry.name === 'string' &&
    typeof entry.symbol === 'string' &&
    /^920\d{3}$/.test(entry.symbol) &&
    typeof entry.legacySymbol === 'string' &&
    /^\d{6}$/.test(entry.legacySymbol)
  );
}

function readCache(value: unknown): CachedBseDirectory | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const cached = value as Partial<CachedBseDirectory>;
  if (
    cached.version !== CACHE_VERSION ||
    typeof cached.fetchedAt !== 'number' ||
    !Number.isFinite(cached.fetchedAt) ||
    typeof cached.lastAttemptAt !== 'number' ||
    !Number.isFinite(cached.lastAttemptAt) ||
    !Array.isArray(cached.entries) ||
    !cached.entries.every(isBseSecurityEntry)
  ) {
    return undefined;
  }
  return cached as CachedBseDirectory;
}

function readBuiltInEntries(value: unknown): readonly BseSecurityEntry[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('内置北交所证券名录格式无效');
  }
  const snapshot = value as { entries?: unknown };
  if (!Array.isArray(snapshot.entries) || !snapshot.entries.every(isBseSecurityEntry)) {
    throw new Error('内置北交所证券名录内容无效');
  }
  return snapshot.entries;
}

function comparableQuery(value: string): string {
  const compact = value.trim().toUpperCase().replace(/\s+/g, '');
  const explicit = compact.match(/^(?:BJ[.:_-]?)?(\d{6})(?:[.:_-]?BJ)?$/);
  return explicit?.[1] ?? compact.toLocaleLowerCase('zh-CN');
}

function matchScore(entry: BseSecurityEntry, query: string): number | undefined {
  const name = entry.name.toLocaleLowerCase('zh-CN');
  if (query === entry.symbol || query === entry.legacySymbol) {
    return 0;
  }
  if (query === name) {
    return 1;
  }
  if (
    entry.symbol.startsWith(query) ||
    entry.legacySymbol.startsWith(query) ||
    name.startsWith(query)
  ) {
    return 2;
  }
  if (entry.symbol.includes(query) || entry.legacySymbol.includes(query) || name.includes(query)) {
    return 3;
  }
  return undefined;
}

export class BseSecurityDirectory {
  private entries: readonly BseSecurityEntry[] | undefined;
  private loading: Promise<readonly BseSecurityEntry[]> | undefined;

  public constructor(
    private readonly cache: SecurityDirectoryCache,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly builtInEntries: readonly BseSecurityEntry[] = readBuiltInEntries(builtInSnapshot),
  ) {}

  public async search(query: string, signal?: AbortSignal): Promise<StockSearchResult[]> {
    const comparable = comparableQuery(query);
    if (!comparable) {
      return [];
    }
    signal?.throwIfAborted();
    const entries = await this.load();
    signal?.throwIfAborted();
    return entries
      .map((entry) => ({ entry, score: matchScore(entry, comparable) }))
      .filter(
        (match): match is { entry: BseSecurityEntry; score: number } =>
          match.score !== undefined,
      )
      .sort((left, right) => left.score - right.score || left.entry.symbol.localeCompare(right.entry.symbol))
      .slice(0, SEARCH_RESULT_LIMIT)
      .map(({ entry }) => ({
        symbol: `${entry.symbol}.BJ`,
        market: 'CN',
        kind: 'stock',
        name: entry.name,
      }));
  }

  private async load(): Promise<readonly BseSecurityEntry[]> {
    if (this.entries) {
      return this.entries;
    }
    if (this.loading) {
      return this.loading;
    }
    this.loading = this.loadFreshOrCached().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadFreshOrCached(): Promise<readonly BseSecurityEntry[]> {
    const cached = readCache(this.cache.get<unknown>(CACHE_KEY));
    if (cached && cached.fetchedAt > 0 && this.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.entries = cached.entries;
      return this.entries;
    }
    const fallback = cached?.entries ?? this.builtInEntries;
    if (cached && this.now() - cached.lastAttemptAt < FAILED_RETRY_MS) {
      this.entries = fallback;
      return this.entries;
    }

    const attemptedAt = this.now();
    try {
      const entries = await this.fetchEntries();
      const value: CachedBseDirectory = {
        version: CACHE_VERSION,
        fetchedAt: attemptedAt,
        lastAttemptAt: attemptedAt,
        entries,
      };
      try {
        await this.cache.update(CACHE_KEY, value);
      } catch {
        // A public directory cache write must not block stock search.
      }
      this.entries = entries;
      return entries;
    } catch {
      const value: CachedBseDirectory = {
        version: CACHE_VERSION,
        fetchedAt: cached?.fetchedAt ?? 0,
        lastAttemptAt: attemptedAt,
        entries: [...fallback],
      };
      try {
        await this.cache.update(CACHE_KEY, value);
      } catch {
        // Keep using the bundled snapshot even if globalState is unavailable.
      }
      this.entries = fallback;
      return this.entries;
    }
  }

  private async fetchEntries(): Promise<BseSecurityEntry[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(BSE_DIRECTORY_URL, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`北交所证券名录请求失败：HTTP ${response.status}`);
      }
      return parseBseSecurityDirectoryHtml(await response.text());
    } finally {
      clearTimeout(timeout);
    }
  }
}
