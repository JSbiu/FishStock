import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Holding, Quote, Stock } from '../domain/models';

class FakeMarkdownString {
  public value = '';
  public supportThemeIcons = false;

  public appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }

  public appendText(value: string): this {
    this.value += value;
    return this;
  }
}

interface QuoteTooltipModule {
  createQuoteTooltip(
    stock: Stock,
    quote: Quote | undefined,
    providerName: string,
  ): FakeMarkdownString;
}

interface HoldingTooltipModule {
  createHoldingTooltip(
    holding: Holding,
    quote: Quote | undefined,
    providerName: string,
    actionHint?: string,
    hkdRate?: number | null,
  ): FakeMarkdownString;
}

function loadUiModule<T>(
  moduleName: string,
  mocks: Readonly<Record<string, unknown>>,
): T {
  const modulePath = require.resolve(moduleName);
  const localRequire = createRequire(modulePath);
  const module = { exports: {} as unknown };
  runInNewContext(readFileSync(modulePath, 'utf8'), {
    module,
    exports: module.exports,
    require: (name: string) => mocks[name] ?? localRequire(name),
  });
  return module.exports as T;
}

const stock: Stock = {
  id: 'stock',
  symbol: '600000.SH',
  market: 'CN',
  name: '浦发银行',
};

const quote: Quote = {
  symbol: stock.symbol,
  market: stock.market,
  name: stock.name ?? stock.symbol,
  currency: 'CNY',
  price: 10,
  previousClose: 9.9,
  open: 9.9,
  high: 10.1,
  low: 9.8,
  volume: 1_000,
  volumeUnit: 'share',
  turnoverAmount: 10_000,
  turnoverRate: 1,
  peTtm: 8,
  totalMarketCap: 100_000,
  settlementPrice: null,
  openInterest: null,
  change: 0.1,
  changePercent: 1,
  asOf: Date.now(),
  state: 'live',
  sessionLabel: '开市',
};

test('quote tooltip shows suspension before live and restores live after resumption', () => {
  const { createQuoteTooltip } = loadUiModule<QuoteTooltipModule>(
    '../ui/quoteTooltip',
    { vscode: { MarkdownString: FakeMarkdownString } },
  );
  const suspended = { ...quote, suspended: true };
  const suspendedText = createQuoteTooltip(stock, suspended, '固定样本').value;
  assert.match(suspendedText, /浦发银行 \(600000\.SH\) · 停牌/);
  assert.doesNotMatch(suspendedText, /· 开市/);

  const resumedText = createQuoteTooltip(
    stock,
    { ...suspended, suspended: false },
    '固定样本',
  ).value;
  assert.match(resumedText, /浦发银行 \(600000\.SH\) · 开市/);
  assert.doesNotMatch(resumedText, /停牌/);
});

test('HKD holding tooltip keeps unit price in HKD while converting amounts', () => {
  const quoteModule = loadUiModule<QuoteTooltipModule>(
    '../ui/quoteTooltip',
    { vscode: { MarkdownString: FakeMarkdownString } },
  );
  const { createHoldingTooltip } = loadUiModule<HoldingTooltipModule>(
    '../ui/holdingTooltip',
    {
      vscode: { MarkdownString: FakeMarkdownString },
      './quoteTooltip': quoteModule,
    },
  );
  const holding: Holding = {
    id: 'hk',
    symbol: '00700.HK',
    market: 'HK',
    kind: 'stock',
    name: '腾讯控股',
    quantity: 100,
    averageCost: 400,
  };
  const hkQuote: Quote = {
    ...quote,
    symbol: holding.symbol,
    market: 'HK',
    name: holding.name ?? holding.symbol,
    currency: 'HKD',
    price: 420,
    previousClose: 410,
    change: 10,
    changePercent: 10 / 410 * 100,
  };
  const converted = createHoldingTooltip(
    holding,
    hkQuote,
    '固定样本',
    undefined,
    0.8557,
  ).value;
  assert.match(converted, /\| 平均成本 \| 400\.00 HKD \|/);
  assert.match(converted, /\| 当前价格 \| 420\.00 HKD \|/);
  assert.match(converted, /\| 成本金额 \| 34,228\.00 CNY \|/);
  assert.match(converted, /\| 当前市值 \| 35,939\.40 CNY \|/);
  assert.match(converted, /港币金额已按 0\.8557 折算；单价保持 HKD。/);

  const raw = createHoldingTooltip(
    holding,
    hkQuote,
    '固定样本',
    undefined,
    null,
  ).value;
  assert.match(raw, /\| 成本金额 \| 40,000\.00 HKD \|/);
  assert.match(raw, /\| 当前市值 \| 42,000\.00 HKD \|/);
  assert.doesNotMatch(raw, /折算/);
});
