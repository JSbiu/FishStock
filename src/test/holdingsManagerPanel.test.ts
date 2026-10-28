import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { HoldingsRepository } from '../storage/holdingsRepository';
import type { HoldingsManagerOptions, HoldingsManagerPanel as ManagerPanel } from '../ui/holdingsManagerPanel';

async function managerHarness(setRate?: HoldingsManagerOptions['setHkdRate']) {
  const holding = {
    id: 'hk', symbol: '00700.HK', market: 'HK', kind: 'stock', name: 'HK sample',
    quantity: 100, averageCost: 400,
  };
  const repository = new HoldingsRepository({
    get: <T>() => ({ version: 1, holdings: [holding] }) as T,
    update: async () => { throw new Error('Display changes must not persist holdings'); },
  });
  await repository.load();
  const messages: Record<string, unknown>[] = [];
  let receive: (message: unknown) => void = () => {};
  const panel = {
    webview: {
      html: '',
      postMessage: (message: Record<string, unknown>) => { messages.push(message); },
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
    },
    onDidDispose: () => {},
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
    require: (name: string) => {
      if (name === 'vscode') {
        return { window: { createWebviewPanel: () => panel }, ViewColumn: { Active: 1 } };
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
    quoteOf: () => undefined,
    search: async () => [],
    watchlistEntries: () => [],
    refresh: async () => {},
    afterSave: async () => {},
    colorConvention: () => 'china',
    hkdRate: () => rate,
    setHkdRate: setRate ?? (async (value) => { rate = value; }),
  });
  manager.show();
  receive({ type: 'ready' });
  messages.length = 0;
  return {
    manager, messages, repository,
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
  harness.manager.show();
  const state = harness.messages.at(-1);
  assert.equal(state?.dirty, true);
  const rows = state?.rows as { quantity: string; averageCost: string }[];
  assert.equal(rows[0].quantity, '123');
  assert.equal(rows[0].averageCost, '401.25');
  assert.equal(harness.repository.getSnapshot().holdings[0].quantity, 100);
});

test('invalid rates do not write configuration and write errors are reported', async () => {
  const attempted: number[] = [];
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
});
