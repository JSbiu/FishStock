import assert from 'node:assert/strict';
import test from 'node:test';
import type { Holding } from '../domain/models';
import {
  HoldingsRepository,
  HoldingsValidationError,
  parseHoldingsState,
} from '../storage/holdingsRepository';
import type { StateStore } from '../storage/watchlistRepository';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();
  public updateCount = 0;
  public failUpdates = false;

  public constructor(initial?: unknown) {
    if (initial !== undefined) {
      this.values.set('fishStock.holdings.v1', initial);
    }
  }

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (this.failUpdates) {
      throw new Error('storage failed');
    }
    this.updateCount += 1;
    this.values.set(key, structuredClone(value));
  }
}

const holding: Holding = {
  id: 'one',
  symbol: '600519.SH',
  market: 'CN',
  kind: 'stock',
  name: '贵州茅台',
  quantity: 100,
  averageCost: 1_490,
};

test('starts empty without creating fictitious financial data', async () => {
  const repository = new HoldingsRepository(new MemoryStateStore());
  assert.deepEqual(await repository.load(), { version: 1, holdings: [] });
});

test('persists additions and position edits independently', async () => {
  const backing = new MemoryStateStore();
  const first = new HoldingsRepository(backing);
  await first.load();
  await first.addHolding(holding);
  await first.updateHolding(holding.id, 120, 1_480.5);

  const second = new HoldingsRepository(backing);
  assert.deepEqual((await second.load()).holdings, [
    { ...holding, quantity: 120, averageCost: 1_480.5 },
  ]);
  await second.removeHolding(holding.id);
  assert.deepEqual(second.getSnapshot().holdings, []);
});

test('loads valid state without a redundant storage write', async () => {
  const backing = new MemoryStateStore({ version: 1, holdings: [holding] });
  const repository = new HoldingsRepository(backing);
  await repository.load();
  assert.equal(backing.updateCount, 0);
});

test('replaces multiple holdings atomically and keeps memory unchanged on storage failure', async () => {
  const backing = new MemoryStateStore({ version: 1, holdings: [holding] });
  const repository = new HoldingsRepository(backing);
  await repository.load();
  const replacement: Holding = {
    id: 'two',
    symbol: '510300.SH',
    market: 'CN',
    kind: 'fund',
    name: '沪深300ETF',
    quantity: 1_000,
    averageCost: 3.82,
  };
  await repository.replaceHoldings([holding, replacement]);
  assert.deepEqual(repository.getSnapshot().holdings, [holding, replacement]);

  backing.failUpdates = true;
  await assert.rejects(repository.replaceHoldings([replacement]), /storage failed/);
  assert.deepEqual(repository.getSnapshot().holdings, [holding, replacement]);
});

test('rejects duplicate, unsupported and invalid positions', async () => {
  const repository = new HoldingsRepository(new MemoryStateStore());
  await repository.load();
  await repository.addHolding(holding);
  await assert.rejects(repository.addHolding({ ...holding, id: 'two' }), /已添加/);
  await assert.rejects(
    repository.updateHolding(holding.id, 0, holding.averageCost),
    HoldingsValidationError,
  );
  assert.throws(
    () => parseHoldingsState({
      version: 1,
      holdings: [{ ...holding, symbol: '000001.SHI' }],
    }),
    /不支持市场指数或期货/,
  );
  assert.throws(
    () => parseHoldingsState({
      version: 1,
      holdings: [{ ...holding, symbol: 'AU0.CNF', market: 'CNF' }],
    }),
    /仅支持 A 股、港股和境内 ETF/,
  );
  assert.throws(
    () => parseHoldingsState({
      version: 1,
      holdings: [{ ...holding, symbol: '00700.HK', market: 'HK', kind: 'fund' }],
    }),
    /基金持仓仅支持境内 ETF/,
  );
});

test('replaces invalid persisted data with an empty safe state', async () => {
  const backing = new MemoryStateStore({
    version: 1,
    holdings: [{ ...holding, averageCost: 0 }],
  });
  const repository = new HoldingsRepository(backing);
  assert.deepEqual(await repository.load(), { version: 1, holdings: [] });
  assert.equal(backing.updateCount, 1);
});
