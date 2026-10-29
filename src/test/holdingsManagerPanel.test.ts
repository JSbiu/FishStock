import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { HoldingsRepository } from '../storage/holdingsRepository';
import type { Quote } from '../domain/models';
import type { HoldingsManagerOptions, HoldingsManagerPanel as ManagerPanel } from '../ui/holdingsManagerPanel';

async function managerHarness(
  setRate?: HoldingsManagerOptions['setHkdRate'],
  quoteOf: HoldingsManagerOptions['quoteOf'] = () => undefined,
  refresh: HoldingsManagerOptions['refresh'] = async () => {},
  overrides: Partial<Pick<HoldingsManagerOptions, 'search' | 'watchlistEntries'>> & {
    persist?: () => Promise<void>;
    choose?: () => Promise<string | undefined>;
  } = {},
) {
  const holding = {
    id: 'hk', symbol: '00700.HK', market: 'HK', kind: 'stock', name: 'HK sample',
    quantity: 100, averageCost: 400,
  };
  const repository = new HoldingsRepository({
    get: <T>() => ({ version: 1, holdings: [holding] }) as T,
    update: overrides.persist ?? (async () => { throw new Error('Display changes must not persist holdings'); }),
  });
  await repository.load();
  const messages: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  let receive: (message: unknown) => void = () => {};
  let onDispose = () => {};
  const panel = {
    webview: {
      html: '',
      postMessage: (message: Record<string, unknown>) => { messages.push(message); },
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
    },
    onDidDispose: (listener: () => void) => { onDispose = listener; },
    reveal: () => {},
    dispose: () => {},
  };
  const modulePath = require.resolve('../ui/holdingsManagerPanel');
  const localRequire = createRequire(modulePath);
  const module = { exports: {} };
  runInNewContext(readFileSync(modulePath, 'utf8'), {
    module,
    exports: module.exports,
    Error,
    AbortController,
    require: (name: string) => {
      if (name === 'vscode') {
        return {
          window: {
            createWebviewPanel: () => panel,
            setStatusBarMessage: () => {},
            showWarningMessage: async (message: string) => {
              warnings.push(message);
              return message === '持仓管理中有未保存的更改。' ? overrides.choose?.() : undefined;
            },
          },
          ViewColumn: { Active: 1 },
        };
      }
      if (name === './quoteTooltip') {
        return { quoteStaleLabel: () => 'stale' };
      }
      return localRequire(name);
    },
  });
  const { HoldingsManagerPanel } = module.exports as { HoldingsManagerPanel: typeof ManagerPanel };
  let rate: number | null = 0.8557;
  const manager = new HoldingsManagerPanel({
    repository,
    quoteOf,
    search: overrides.search ?? (async () => []),
    watchlistEntries: overrides.watchlistEntries ?? (() => []),
    refresh,
    afterSave: async () => {},
    colorConvention: () => 'china',
    hkdRate: () => rate,
    setHkdRate: setRate ?? (async (value) => { rate = value; }),
  });
  manager.show();
  receive({ type: 'ready' });
  messages.length = 0;
  return {
    manager, messages, repository, warnings,
    close: () => { onDispose(); },
    setRate: (value: number | null) => { rate = value; },
    send: async (message: unknown) => {
      receive(message);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test('quote updates always carry the current rate, including explicit null', async () => {
  const harness = await managerHarness();
  for (const rate of [0.8557, 0.9, null]) {
    harness.setRate(rate);
    harness.manager.updateQuotes();
    assert.equal(harness.messages.at(-1)?.type, 'quoteUpdate');
    assert.equal(harness.messages.at(-1)?.hkdRate, rate);
  }
});

test('a pending save locks draft mutations and duplicate saves until the single write finishes', async () => {
  let finish = () => {};
  let writes = 0;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const harness = await managerHarness(undefined, undefined, undefined, {
    persist: async () => { writes += 1; await pending; },
  });
  const draft = [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }];
  await harness.send({ type: 'save', rows: draft });
  assert.equal(harness.messages[0].type, 'saving');
  assert.equal(harness.messages[0].value, true);
  await harness.send({ type: 'draftChanged', rows: [{ ...draft[0], quantity: '456' }] });
  await harness.send({ type: 'save', rows: [] });
  await harness.send({ type: 'discard' });
  await harness.send({ type: 'adjustApply', symbol: '00700.HK', direction: 'sell', quantity: 100, price: 500 });
  assert.equal(writes, 1);
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 123);
  const saved = harness.messages.find((message) => message.type === 'state');
  assert.equal(saved?.dirty, false);
  assert.equal((saved?.rows as { quantity: string }[])[0].quantity, '123');
  assert.equal(harness.messages.at(-1)?.type, 'saving');
  assert.equal(harness.messages.at(-1)?.value, false);
});

test('a failed save preserves the draft and confirmed instruments for a successful retry', async () => {
  let fail = true;
  const harness = await managerHarness(undefined, undefined, undefined, {
    persist: async () => { if (fail) throw new Error('Storage unavailable'); },
    watchlistEntries: () => [{ symbol: '000333.SZ', market: 'CN', kind: 'stock', name: 'CN sample' }],
  });
  const draft = [
    { id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' },
    { symbol: '000333.SZ', quantity: '200', averageCost: '50' },
  ];
  await harness.send({ type: 'save', rows: draft });
  assert.equal(harness.repository.getSnapshot().holdings.length, 1);
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
  assert.equal(harness.messages.find((message) => message.type === 'saveError')?.message, 'Storage unavailable');
  assert.equal(harness.messages.at(-1)?.value, false);
  await harness.send({ type: 'ready' });
  const state = harness.messages.at(-1);
  assert.equal(state?.dirty, true);
  assert.equal(state?.saveError, 'Storage unavailable');
  assert.equal((state?.rows as unknown[]).length, 2);
  fail = false;
  await harness.send({ type: 'save', rows: draft });
  assert.equal(harness.repository.getSnapshot().holdings.length, 2);
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 123);
});

test('closing during a save waits for success without prompting for an already saved draft', async () => {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const harness = await managerHarness(undefined, undefined, undefined, { persist: () => pending });
  await harness.send({ type: 'save', rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '400' }] });
  harness.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.warnings, []);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.warnings, []);
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 123);
});

test('saving on close reports the actual validation or storage error and restores the draft', async () => {
  for (const quantity of ['0', '123']) {
    const harness = await managerHarness(undefined, undefined, undefined, {
      persist: async () => { throw new Error('Storage unavailable'); },
      choose: async () => '保存',
    });
    await harness.send({ type: 'draftChanged', rows: [{ id: 'hk', symbol: '00700.HK', quantity, averageCost: '400' }] });
    harness.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(harness.warnings.at(-1) ?? '', quantity === '0' ? /正整数/ : /Storage unavailable/);
    await harness.send({ type: 'ready' });
    assert.equal(harness.messages.at(-1)?.dirty, true);
    assert.equal((harness.messages.at(-1)?.rows as { quantity: string }[])[0].quantity, quantity);
    assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
  }
});

test('manual refresh success and failure release busy state without replacing the draft', async () => {
  for (const fail of [false, true]) {
    let finishRefresh: () => void = () => {};
    const pending = new Promise<void>((resolve, reject) => {
      finishRefresh = () => fail ? reject(new Error('Refresh failed')) : resolve();
    });
    const harness = await managerHarness(undefined, undefined, () => pending);
    await harness.send({
      type: 'draftChanged',
      rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }],
    });
    await harness.send({ type: 'refresh' });
    assert.equal(harness.messages[0].type, 'busy');
    assert.equal(harness.messages[0].value, true);
    finishRefresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.messages.map((message) => message.type), fail
      ? ['busy', 'operationError', 'busy']
      : ['busy', 'quoteUpdate', 'operationNotice', 'busy']);
    assert.equal(harness.messages.at(-1)?.value, false);
    await harness.send({ type: 'ready' });
    const state = harness.messages.at(-1);
    assert.equal(state?.dirty, true);
    assert.equal((state?.rows as { quantity: string }[])[0].quantity, '123');
    assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
  }
});

test('changing the rate updates quotes without replacing an unsaved draft', async () => {
  const harness = await managerHarness();
  await harness.send({
    type: 'draftChanged',
    rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }],
  });
  await harness.send({ type: 'setHkdRate', value: 0.9 });
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].type, 'quoteUpdate');
  assert.equal(harness.messages[0].hkdRate, 0.9);
  await harness.send({ type: 'ready' });
  const state = harness.messages.at(-1);
  assert.equal(state?.dirty, true);
  const rows = state?.rows as { quantity: string; averageCost: string }[];
  assert.equal(rows[0].quantity, '123');
  assert.equal(rows[0].averageCost, '401.25');
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
});

test('revealing an existing manager sends only the requested focus without replacing its draft', async () => {
  const harness = await managerHarness();
  await harness.send({
    type: 'draftChanged',
    rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }],
  });
  harness.manager.show();
  assert.equal(harness.messages.length, 0);
  for (const focus of [{ type: 'search' }, { type: 'holding', holdingId: 'hk' }] as const) {
    harness.manager.show(focus);
    assert.equal(harness.messages.at(-1)?.type, 'focus');
    assert.deepEqual(harness.messages.at(-1)?.focus, focus);
  }
  assert.equal(harness.messages.some((message) => message.type === 'state'), false);
  await harness.send({ type: 'ready' });
  assert.equal(harness.messages.at(-1)?.dirty, true);
  assert.equal((harness.messages.at(-1)?.rows as { quantity: string }[])[0].quantity, '123');
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
});

test('repository changes reload a clean manager and preserve an unsaved draft', async () => {
  const harness = await managerHarness(undefined, undefined, undefined, { persist: async () => {} });
  await harness.repository.updateHolding('hk', 200, 410);
  harness.manager.repositoryChanged();
  assert.equal(harness.messages.at(-1)?.type, 'state');
  assert.equal((harness.messages.at(-1)?.rows as { quantity: string }[])[0].quantity, '200');
  await harness.send({
    type: 'draftChanged', rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }],
  });
  await harness.repository.updateHolding('hk', 300, 420);
  harness.manager.repositoryChanged();
  assert.equal(harness.messages.at(-1)?.type, 'quoteUpdate');
  await harness.send({ type: 'ready' });
  assert.equal((harness.messages.at(-1)?.rows as { quantity: string }[])[0].quantity, '123');
});

test('cancel, discard and successful save reject late search results and errors', async () => {
  for (const action of ['cancelSearch', 'discard', 'save']) {
    for (const fail of [false, true]) {
      let finish = () => {};
      let signal: AbortSignal | undefined;
      const harness = await managerHarness(undefined, undefined, undefined, {
        persist: async () => {},
        search: (_query, receivedSignal) => {
          signal = receivedSignal;
          return new Promise((resolve, reject) => {
            finish = () => fail ? reject(new Error('Late search error')) : resolve([
              { symbol: '000333.SZ', market: 'CN', kind: 'stock', name: 'CN sample' },
            ]);
          });
        },
      });
      await harness.send({ type: 'search', query: 'A', requestId: 1 });
      await harness.send({ type: action, rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '400' }] });
      assert.equal(signal?.aborted, true);
      const before = harness.messages.length;
      finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(harness.messages.length, before);
    }
  }
});

test('only the current search can return results when providers ignore cancellation', async () => {
  const pending: ((name: string) => void)[] = [];
  const harness = await managerHarness(undefined, undefined, undefined, {
    search: () => new Promise((resolve) => {
      pending.push((name) => resolve([{ symbol: '000333.SZ', market: 'CN', kind: 'stock', name }]));
    }),
  });
  await harness.send({ type: 'search', query: 'A', requestId: 1 });
  await harness.send({ type: 'search', query: 'B', requestId: 2 });
  pending[1]('Current result');
  pending[0]('Outdated result');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].requestId, 2);
  assert.equal((harness.messages[0].results as { name: string }[])[0].name, 'Current result');
});

test('invalid rates do not write configuration and write errors are reported', async () => {
  const attempted: (number | null)[] = [];
  const harness = await managerHarness(async (value) => {
    attempted.push(value);
    throw new Error('Configuration write failed');
  });
  for (const value of [0, 0.09, 2.01, Number.NaN, '0.9']) {
    await harness.send({ type: 'setHkdRate', value });
  }
  assert.deepEqual(attempted, []);
  await harness.send({ type: 'setHkdRate', value: 0.9 });
  assert.deepEqual(attempted, [0.9]);
  assert.equal(harness.messages.at(-1)?.type, 'operationError');
  assert.equal(harness.messages.at(-1)?.message, 'Configuration write failed');
  assert.equal(harness.messages.at(-1)?.hkdRate, 0.8557);
});

test('the conversion switch accepts null and resumes without saving the holdings draft', async () => {
  const harness = await managerHarness();
  for (const value of [null, 0.8557]) {
    await harness.send({ type: 'setHkdRate', value });
    assert.equal(harness.messages.at(-1)?.type, 'quoteUpdate');
    assert.equal(harness.messages.at(-1)?.hkdRate, value);
  }
  assert.equal(harness.repository.getSnapshot().holdings[0].averageCost, 400);
});

test('manager labels a suspended quote before session and stale labels, and restores on resumption', async () => {
  const quote: Quote = {
    symbol: '00700.HK', market: 'HK', name: 'HK sample', currency: 'HKD',
    price: 420, previousClose: 420, open: null, high: null, low: null,
    volume: null, volumeUnit: null, turnoverAmount: null, turnoverRate: null,
    peTtm: null, totalMarketCap: null, settlementPrice: null, openInterest: null,
    change: 0, changePercent: 0, asOf: Date.now(), state: 'live', suspended: true,
  };
  const harness = await managerHarness(undefined, () => quote);
  for (const state of ['live', 'closed', 'stale'] as const) {
    quote.state = state;
    quote.sessionLabel = state === 'closed' ? '休市' : '开市';
    quote.suspended = true;
    harness.manager.updateQuotes();
    const suspended = harness.messages.at(-1)?.quotes as { quoteStateLabel: string; dayChange: number | null }[];
    assert.equal(suspended[0].quoteStateLabel, '停牌');
    assert.equal(suspended[0].dayChange, null);
    quote.suspended = false;
    harness.manager.updateQuotes();
    const resumed = harness.messages.at(-1)?.quotes as { quoteStateLabel: string }[];
    assert.equal(resumed[0].quoteStateLabel, state === 'stale' ? 'stale' : quote.sessionLabel);
  }
});
