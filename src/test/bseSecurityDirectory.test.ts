import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BseSecurityDirectory,
  parseBseSecurityDirectoryHtml,
  type SecurityDirectoryCache,
} from '../data/bseSecurityDirectory';

const DIRECTORY_HTML = `
  <table><tbody>
    <tr><td>序号</td><td>证券简称</td><td>上市日期</td><td>旧代码</td><td>新代码</td></tr>
    <tr><td>1</td><td><span>诺思兰德</span></td><td>2020/11/24</td><td>430047</td><td>920047</td></tr>
    <tr><td>2</td><td>贝特瑞</td><td>2020/7/27</td><td>835185</td><td>920185</td></tr>
  </tbody></table>
`;

class MemoryCache implements SecurityDirectoryCache {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('parses official BSE old-to-new code rows', () => {
  assert.deepEqual(parseBseSecurityDirectoryHtml(DIRECTORY_HTML), [
    { symbol: '920047', name: '诺思兰德', legacySymbol: '430047' },
    { symbol: '920185', name: '贝特瑞', legacySymbol: '835185' },
  ]);
});

test('searches BSE securities by Chinese name, current code, and legacy code', async () => {
  let requests = 0;
  const directory = new BseSecurityDirectory(
    new MemoryCache(),
    async () => {
      requests += 1;
      return new Response(DIRECTORY_HTML);
    },
    () => 1_000,
  );

  assert.deepEqual(await directory.search('诺思兰德'), [
    { symbol: '920047.BJ', market: 'CN', name: '诺思兰德' },
  ]);
  assert.deepEqual(await directory.search('920185'), [
    { symbol: '920185.BJ', market: 'CN', name: '贝特瑞' },
  ]);
  assert.deepEqual(await directory.search('bj430047'), [
    { symbol: '920047.BJ', market: 'CN', name: '诺思兰德' },
  ]);
  assert.equal(requests, 1);
});

test('reuses the persisted BSE directory cache in a new provider instance', async () => {
  const cache = new MemoryCache();
  const first = new BseSecurityDirectory(
    cache,
    async () => new Response(DIRECTORY_HTML),
    () => 1_000,
  );
  await first.search('贝特瑞');

  const second = new BseSecurityDirectory(
    cache,
    async () => {
      throw new Error('fresh cache should avoid a network request');
    },
    () => 2_000,
  );
  assert.deepEqual(await second.search('835185'), [
    { symbol: '920185.BJ', market: 'CN', name: '贝特瑞' },
  ]);
});

test('uses the bundled BSE directory and backs off for 24 hours after an update failure', async () => {
  const cache = new MemoryCache();
  const builtIn = parseBseSecurityDirectoryHtml(DIRECTORY_HTML);
  let requests = 0;
  const failingFetch: typeof fetch = async () => {
    requests += 1;
    throw new Error('BSE website unavailable');
  };
  const first = new BseSecurityDirectory(cache, failingFetch, () => 1_000_000_000, builtIn);
  assert.deepEqual(await first.search('诺思兰德'), [
    { symbol: '920047.BJ', market: 'CN', name: '诺思兰德' },
  ]);

  const second = new BseSecurityDirectory(
    cache,
    failingFetch,
    () => 1_000_000_000 + 23 * 60 * 60 * 1_000,
    builtIn,
  );
  assert.deepEqual(await second.search('430047'), [
    { symbol: '920047.BJ', market: 'CN', name: '诺思兰德' },
  ]);
  assert.equal(requests, 1);
});
