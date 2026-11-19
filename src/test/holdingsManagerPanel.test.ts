import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { HoldingsRepository } from '../storage/holdingsRepository';
import type { Quote } from '../domain/models';
import {
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_DESCRIPTION_FIELD_ORDER,
  type HoldingDescriptionField,
  type HoldingDescriptionFields,
} from '../domain/holdings';
import type { HoldingSummaryMode } from '../domain/holdingGroups';
import type { HoldingsManagerOptions, HoldingsManagerPanel as ManagerPanel } from '../ui/holdingsManagerPanel';

async function managerHarness(
  setRate?: HoldingsManagerOptions['setHkdRate'],
  quoteOf: HoldingsManagerOptions['quoteOf'] = () => undefined,
  refresh: HoldingsManagerOptions['refresh'] = async () => {},
  overrides: Partial<Pick<
    HoldingsManagerOptions,
    'search' | 'watchlistEntries' | 'setDescriptionDisplay' | 'setSummaryMode'
  >> & {
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
  let descriptionFields: HoldingDescriptionFields = {
    ...DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  };
  let descriptionFieldOrder: HoldingDescriptionField[] = [
    ...DEFAULT_HOLDING_DESCRIPTION_FIELD_ORDER,
  ];
  let summaryMode: HoldingSummaryMode = 'group';
  let receive: (message: unknown) => void = () => {};
  let onDispose = () => {};
  const panel = {
    title: '',
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
    descriptionFields: () => ({ ...descriptionFields }),
    descriptionFieldOrder: () => [...descriptionFieldOrder],
    setDescriptionDisplay:
      overrides.setDescriptionDisplay
      ?? (async (fields, order) => {
        descriptionFields = { ...fields };
        descriptionFieldOrder = [...order];
      }),
    summaryMode: () => summaryMode,
    setSummaryMode:
      overrides.setSummaryMode
      ?? (async (mode) => {
        summaryMode = mode;
      }),
  });
  manager.show();
  receive({ type: 'ready' });
  messages.length = 0;
  return {
    manager, messages, repository, warnings,
    panelTitle: () => panel.title,
    html: () => panel.webview.html,
    close: () => { onDispose(); },
    setRate: (value: number | null) => { rate = value; },
    descriptionFields: () => ({ ...descriptionFields }),
    descriptionFieldOrder: () => [...descriptionFieldOrder],
    summaryMode: () => summaryMode,
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

test('manager tab title marks unsaved drafts and clears after save or discard', async () => {
  const harness = await managerHarness(undefined, undefined, undefined, {
    persist: async () => {},
  });
  assert.equal(harness.panelTitle(), 'FishStock 持仓管理');
  const draft = [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }];
  await harness.send({ type: 'draftChanged', rows: draft });
  assert.equal(harness.panelTitle(), 'FishStock 持仓管理（有未保存更改）');
  await harness.send({ type: 'save', rows: draft });
  assert.equal(harness.panelTitle(), 'FishStock 持仓管理');
  await harness.send({ type: 'draftChanged', rows: draft });
  await harness.send({ type: 'discard' });
  assert.equal(harness.panelTitle(), 'FishStock 持仓管理');
});

test('manager page exposes Ctrl+S through the same guarded save action', async () => {
  const harness = await managerHarness();
  const html = harness.html();
  assert.match(html, /aria-keyshortcuts="Control\+S Meta\+S"/);
  assert.match(html, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(html, /event\.key\.toLowerCase\(\) === 's'/);
  assert.match(html, /saveButton\.addEventListener\('click', requestSave\)/);
  assert.match(html, /requestSave\(\);/);
  assert.equal((html.match(/type: 'save'/g) ?? []).length, 1);
});

test('manager page keeps current price in its original currency while converting amounts', async () => {
  const html = (await managerHarness()).html();
  assert.match(
    html,
    /formatNumber\(row\.currentPrice, 2, 4\) \+ ' ' \+ row\.currency/,
  );
  assert.doesNotMatch(
    html,
    /formatNumber\(convertAmount\(row, row\.currentPrice\)/,
  );
  assert.match(
    html,
    /formatNumber\(convertAmount\(row, profit\), 2, 2\) \+ ' ' \+ displayCurrency\(row\)/,
  );
});

test('manager page exposes cash and position controls with parseable script', async () => {
  const html = (await managerHarness()).html();
  assert.match(html, /id="cashAmount"/);
  assert.match(html, /id="cashCurrency"/);
  assert.match(html, /id="assetTotal"/);
  assert.match(html, /id="assetNote"/);
  assert.match(html, /id="fieldOrderList"/);
  assert.match(html, /id="summaryMode"/);
  assert.match(html, /<th>标签<\/th>/);
  assert.match(html, /td\.colSpan = 14/);
  assert.match(html, /for \(let index = 0; index < 5; index \+= 1\)/);
  assert.match(html, /<th>仓位<\/th>/);
  assert.match(html, /现金不参与浮动盈亏或当日盈亏/);
  assert.match(html, /用 ↑ ↓ 调整左右顺序/);
  const script = html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('manager carries description field visibility and order in the page state', async () => {
  const harness = await managerHarness();
  await harness.send({ type: 'ready' });
  const state = harness.messages.find((message) => message.type === 'state');
  assert.deepEqual(state?.descriptionFields, {
    quantity: true,
    marketValue: true,
    weight: true,
    profit: true,
    dayProfit: true,
  });
  assert.deepEqual(state?.descriptionFieldOrder, [
    'quantity',
    'marketValue',
    'weight',
    'profit',
    'dayProfit',
  ]);
  assert.equal(state?.summaryMode, 'group');
});

test('manager normalizes field order and keeps at least one visible field', async () => {
  const harness = await managerHarness();
  await harness.send({
    type: 'setDescriptionDisplay',
    fields: {
      quantity: false,
      marketValue: false,
      weight: false,
      profit: false,
      dayProfit: false,
    },
    order: ['profit', 'profit', 'bogus', 'quantity'],
  });
  const response = harness.messages.at(-1);
  assert.equal(response?.type, 'descriptionDisplay');
  assert.deepEqual(response?.fields, {
    quantity: false,
    marketValue: true,
    weight: false,
    profit: false,
    dayProfit: false,
  });
  assert.deepEqual(response?.order, [
    'profit',
    'quantity',
    'marketValue',
    'weight',
    'dayProfit',
  ]);
  assert.deepEqual(harness.descriptionFields(), response?.fields);
  assert.deepEqual(harness.descriptionFieldOrder(), response?.order);
});

test('manager reports field display write errors with the current values', async () => {
  const harness = await managerHarness(undefined, undefined, undefined, {
    setDescriptionDisplay: async () => {
      throw new Error('Display configuration failed');
    },
  });
  await harness.send({
    type: 'setDescriptionDisplay',
    fields: {
      quantity: true,
      marketValue: true,
      weight: true,
      profit: true,
      dayProfit: false,
    },
    order: ['profit', 'quantity', 'marketValue', 'weight', 'dayProfit'],
  });
  const response = harness.messages.at(-1);
  assert.equal(response?.type, 'operationError');
  assert.equal(response?.message, 'Display configuration failed');
  assert.deepEqual(response?.descriptionFields, {
    quantity: true,
    marketValue: true,
    weight: true,
    profit: true,
    dayProfit: true,
  });
  assert.deepEqual(response?.descriptionFieldOrder, [
    'quantity',
    'marketValue',
    'weight',
    'profit',
    'dayProfit',
  ]);
});

test('manager switches the total tooltip summary mode', async () => {
  const harness = await managerHarness();
  assert.equal(harness.summaryMode(), 'group');
  await harness.send({ type: 'setSummaryMode', mode: 'tag' });
  assert.equal(harness.summaryMode(), 'tag');
  assert.equal(harness.messages.at(-1)?.type, 'summaryMode');
  assert.equal(harness.messages.at(-1)?.mode, 'tag');
  await harness.send({ type: 'setSummaryMode', mode: 'invalid' });
  assert.equal(harness.summaryMode(), 'group');
});

test('manager saves cash together with holdings in one portfolio write', async () => {
  const harness = await managerHarness(undefined, undefined, undefined, {
    persist: async () => {},
  });
  await harness.send({
    type: 'save',
    rows: [{
      id: 'hk',
      symbol: '00700.HK',
      tag: '核心',
      quantity: '123',
      averageCost: '401.25',
    }],
    cash: { amount: '1234.5', currency: 'HKD' },
  });
  assert.equal(harness.repository.getSnapshot().holdings[0].tag, '核心');
  assert.deepEqual(harness.repository.getSnapshot().cash, {
    amount: 1_234.5,
    currency: 'HKD',
  });
  const state = harness.messages.find((message) => message.type === 'state');
  assert.deepEqual(state?.cash, { amount: 1_234.5, currency: 'HKD' });
});

test('manager rejects invalid cash before writing the portfolio', async () => {
  const harness = await managerHarness();
  const before = harness.repository.getSnapshot();
  await harness.send({
    type: 'save',
    rows: [{ id: 'hk', symbol: '00700.HK', quantity: '123', averageCost: '401.25' }],
    cash: { amount: '-1', currency: 'CNY' },
  });
  assert.ok(harness.messages.some((message) =>
    message.type === 'saveError' && /现金金额/.test(String(message.message))));
  assert.equal(harness.messages.at(-1)?.type, 'saving');
  assert.equal(harness.messages.at(-1)?.value, false);
  assert.equal(harness.panelTitle(), 'FishStock 持仓管理（有未保存更改）');
  assert.deepEqual(harness.repository.getSnapshot(), before);
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
