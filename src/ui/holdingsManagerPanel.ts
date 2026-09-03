import { randomUUID } from 'node:crypto';
import {
  env,
  Uri,
  ViewColumn,
  window,
  type Disposable,
  type WebviewPanel,
} from 'vscode';
import {
  materializeHoldingDraft,
  type HoldingDraftInput,
} from '../domain/holdingDraft';
import { holdingDayChange } from '../domain/holdings';
import {
  applyHoldingAdjustment,
  type AdjustmentDirection,
  type HoldingAdjustmentResult,
} from '../domain/holdingAdjustment';
import type {
  Holding,
  HoldingCurrency,
  HoldingSearchResult,
  Quote,
} from '../domain/models';
import type { ColorConvention } from '../config';
import { buildQuoteUrl } from '../domain/quoteUrl';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import { quoteStaleLabel } from './quoteTooltip';

export type HoldingsManagerFocus =
  | { type: 'search' }
  | { type: 'holding'; holdingId: string };

export interface HoldingsManagerOptions {
  repository: HoldingsRepository;
  search(query: string, signal?: AbortSignal): Promise<HoldingSearchResult[]>;
  watchlistEntries(): HoldingSearchResult[];
  quoteOf(holding: Pick<Holding, 'symbol' | 'market' | 'kind'>): Quote | undefined;
  refresh(): Promise<void>;
  afterSave(added: readonly Holding[]): Promise<void>;
  colorConvention(): ColorConvention;
}

interface ManagerQuoteFields {
  currentPrice: number | null;
  currency: HoldingCurrency;
  quoteState: Quote['state'] | 'missing';
  quoteStateLabel: string;
  dayChange: number | null;
}

interface ManagerRow extends ManagerQuoteFields {
  id?: string;
  symbol: string;
  market: 'CN' | 'HK';
  kind: Holding['kind'];
  name: string;
  quantity: unknown;
  averageCost: unknown;
}

interface ManagerSearchResult extends ManagerQuoteFields {
  symbol: string;
  market: 'CN' | 'HK';
  kind: Holding['kind'];
  name: string;
  abbreviation?: string;
}

interface AdjustmentPayload {
  symbol: string;
  direction: AdjustmentDirection;
  quantity: number;
  price: number;
}

interface AdjustmentBaseline {
  quantity: number;
  averageCost: number;
}

interface AdjustmentOutcome {
  before: AdjustmentBaseline;
  result: HoldingAdjustmentResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function formatQuantityValue(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatPriceValue(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatAmountValue(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedAmount(value: number): string {
  return `${value >= 0 ? '+' : '-'}${formatAmountValue(Math.abs(value))}`;
}

function adjustmentMessage(
  payload: AdjustmentPayload,
  before: AdjustmentBaseline,
  result: HoldingAdjustmentResult,
): string {
  const traded = `${formatQuantityValue(payload.quantity)} @ ${formatPriceValue(payload.price)}`;
  if (payload.direction === 'buy') {
    return `已加仓 ${traded}：平均成本 ${formatPriceValue(before.averageCost)} → ${formatPriceValue(result.averageCost)}`;
  }
  const realized = `已实现盈亏 ${formatSignedAmount(result.realizedProfit)} 不计入`;
  if (result.cleared) {
    return `已清仓 ${traded}：保存后移除该持仓，${realized}`;
  }
  return `已减仓 ${traded}：平均成本保持 ${formatPriceValue(result.averageCost)}，${realized}`;
}

function readAdjustmentPayload(
  message: Record<string, unknown>,
): AdjustmentPayload | undefined {
  const symbol = typeof message.symbol === 'string' ? message.symbol.trim() : '';
  const direction: AdjustmentDirection | undefined =
    message.direction === 'buy' || message.direction === 'sell'
      ? message.direction
      : undefined;
  if (!symbol || direction === undefined) {
    return undefined;
  }
  return {
    symbol,
    direction,
    quantity: Number(message.quantity),
    price: Number(message.price),
  };
}

function readDraftInputs(value: unknown): HoldingDraftInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((row) => {
    if (!isRecord(row)) {
      return {};
    }
    return {
      ...(row.id !== undefined ? { id: row.id } : {}),
      symbol: row.symbol,
      quantity: row.quantity,
      averageCost: row.averageCost,
    };
  });
}

function toDraftInputs(holdings: readonly Holding[]): HoldingDraftInput[] {
  return holdings.map((holding) => ({
    id: holding.id,
    symbol: holding.symbol,
    quantity: String(holding.quantity),
    averageCost: String(holding.averageCost),
  }));
}

function quoteFields(
  instrument: Pick<Holding, 'symbol' | 'market' | 'kind'>,
  quoteOf: HoldingsManagerOptions['quoteOf'],
): ManagerQuoteFields {
  const quote = quoteOf(instrument);
  const currency: HoldingCurrency = instrument.market === 'HK' ? 'HKD' : 'CNY';
  if (!quote || quote.state === 'error' || quote.price === null || quote.price <= 0) {
    return {
      currentPrice: null,
      currency,
      quoteState: quote?.state ?? 'missing',
      quoteStateLabel: '暂不可用',
      dayChange: null,
    };
  }
  return {
    currentPrice: quote.price,
    currency,
    quoteState: quote.state,
    quoteStateLabel: quoteStateLabelOf(quote),
    dayChange: holdingDayChange(quote),
  };
}

function quoteStateLabelOf(quote: Quote): string {
  if (quote.state === 'stale') {
    return quoteStaleLabel(quote);
  }
  const fallback = quote.state === 'closed' ? '休市' : '实时';
  return quote.sessionLabel ?? fallback;
}

export class HoldingsManagerPanel implements Disposable {
  private panel: WebviewPanel | undefined;
  private draft: HoldingDraftInput[] | undefined;
  private dirty = false;
  private pendingFocus: HoldingsManagerFocus | undefined;
  private searchController: AbortController | undefined;
  private readonly allowedNewInstruments = new Map<string, HoldingSearchResult>();
  private disposing = false;
  private webviewReady = false;

  public constructor(private readonly options: HoldingsManagerOptions) {}

  public show(focus?: HoldingsManagerFocus): void {
    this.pendingFocus = focus;
    if (this.panel) {
      this.panel.reveal(ViewColumn.Active, true);
      this.postState();
      return;
    }

    const panel = window.createWebviewPanel(
      'fishStock.holdingsManager',
      'FishStock 持仓管理',
      ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    this.webviewReady = false;
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      this.searchController?.abort();
      this.searchController = undefined;
      this.panel = undefined;
      this.webviewReady = false;
      if (!this.disposing && this.dirty && this.draft) {
        void this.confirmUnsavedDraft();
      }
    });
  }

  public updateQuotes(): void {
    if (this.panel && this.webviewReady) {
      void this.panel.webview.postMessage({
        type: 'quoteUpdate',
        colorConvention: this.options.colorConvention(),
        quotes: this.managerRows().map((row) => ({
          symbol: row.symbol,
          currentPrice: row.currentPrice,
          currency: row.currency,
          quoteState: row.quoteState,
          quoteStateLabel: row.quoteStateLabel,
          dayChange: row.dayChange,
        })),
      });
    }
  }

  public repositoryChanged(): void {
    if (this.dirty) {
      this.updateQuotes();
      return;
    }
    this.draft = undefined;
    this.postState();
  }

  public dispose(): void {
    this.disposing = true;
    this.searchController?.abort();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private currentDraft(): HoldingDraftInput[] {
    return this.draft ?? toDraftInputs(this.options.repository.getSnapshot().holdings);
  }

  private managerRows(): ManagerRow[] {
    const existingById = new Map(
      this.options.repository.getSnapshot().holdings.map((holding) => [holding.id, holding]),
    );
    return this.currentDraft().flatMap((input) => {
      const existing = typeof input.id === 'string'
        ? existingById.get(input.id)
        : undefined;
      const symbol = typeof input.symbol === 'string' ? input.symbol : '';
      const instrument = existing ?? this.allowedNewInstruments.get(symbol);
      if (!instrument) {
        return [];
      }
      return [{
        ...(existing ? { id: existing.id } : {}),
        symbol: instrument.symbol,
        market: instrument.market,
        kind: instrument.kind,
        name: instrument.name ?? instrument.symbol,
        quantity: input.quantity,
        averageCost: input.averageCost,
        ...quoteFields(instrument, this.options.quoteOf),
      }];
    });
  }

  private watchlistSnapshot(): ManagerSearchResult[] {
    const entries = this.options.watchlistEntries();
    for (const entry of entries) {
      this.allowedNewInstruments.set(entry.symbol, entry);
    }
    return entries.map((entry) => ({
      symbol: entry.symbol,
      market: entry.market,
      kind: entry.kind,
      name: entry.name,
      ...quoteFields(entry, this.options.quoteOf),
    }));
  }

  private postState(message?: string, clearSearch = false): void {
    const panel = this.panel;
    if (!panel || !this.webviewReady) {
      return;
    }
    const focus = this.pendingFocus;
    this.pendingFocus = undefined;
    void panel.webview.postMessage({
      type: 'state',
      rows: this.managerRows(),
      dirty: this.dirty,
      colorConvention: this.options.colorConvention(),
      clearSearch,
      watchlistEntries: this.watchlistSnapshot(),
      ...(focus ? { focus } : {}),
      ...(message ? { message } : {}),
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.postState();
        return;
      case 'draftChanged': {
        const rows = readDraftInputs(message.rows);
        if (!rows) {
          return;
        }
        this.draft = rows;
        this.dirty = true;
        return;
      }
      case 'discard':
        this.draft = undefined;
        this.dirty = false;
        this.allowedNewInstruments.clear();
        this.postState('未保存更改已放弃', true);
        return;
      case 'save': {
        const rows = readDraftInputs(message.rows);
        if (!rows) {
          return;
        }
        this.draft = rows;
        this.dirty = true;
        await this.saveCurrentDraft(true);
        return;
      }
      case 'search':
        await this.search(message);
        return;
      case 'watchlist':
        void this.panel?.webview.postMessage({
          type: 'watchlistEntries',
          entries: this.watchlistSnapshot(),
        });
        return;
      case 'adjustPreview':
        await this.adjustPreview(message);
        return;
      case 'adjustApply':
        await this.adjustApply(message);
        return;
      case 'refresh':
        await this.refreshQuotes();
        return;
      case 'openQuote':
        await this.openQuote(message.symbol);
        return;
      default:
        return;
    }
  }

  private async search(message: Record<string, unknown>): Promise<void> {
    if (typeof message.query !== 'string' || typeof message.requestId !== 'number') {
      return;
    }
    const query = message.query.trim();
    if (!query) {
      return;
    }
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    try {
      const results = await this.options.search(query, controller.signal);
      if (controller.signal.aborted || this.searchController !== controller) {
        return;
      }
      for (const result of results) {
        this.allowedNewInstruments.set(result.symbol, result);
      }
      const payload: ManagerSearchResult[] = results.map((result) => ({
        symbol: result.symbol,
        market: result.market,
        kind: result.kind,
        name: result.name,
        ...(result.abbreviation ? { abbreviation: result.abbreviation } : {}),
        ...quoteFields(result, this.options.quoteOf),
      }));
      void this.panel?.webview.postMessage({
        type: 'searchResults',
        requestId: message.requestId,
        results: payload,
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      void this.panel?.webview.postMessage({
        type: 'searchError',
        requestId: message.requestId,
        message: messageOf(error),
      });
    } finally {
      if (this.searchController === controller) {
        this.searchController = undefined;
      }
    }
  }

  private async refreshQuotes(): Promise<void> {
    void this.panel?.webview.postMessage({ type: 'busy', value: true });
    try {
      await this.options.refresh();
      this.postState('行情已刷新');
    } catch (error: unknown) {
      void this.panel?.webview.postMessage({
        type: 'operationError',
        message: messageOf(error),
      });
    } finally {
      void this.panel?.webview.postMessage({ type: 'busy', value: false });
    }
  }

  private computeAdjustment(
    payload: AdjustmentPayload,
  ): AdjustmentOutcome | { error: string } {
    const row = this.currentDraft().find((input) => input.symbol === payload.symbol);
    if (!row) {
      return { error: '草稿中找不到该持仓' };
    }
    const before: AdjustmentBaseline = {
      quantity: Number(row.quantity),
      averageCost: Number(row.averageCost),
    };
    try {
      return {
        before,
        result: applyHoldingAdjustment(before, {
          direction: payload.direction,
          quantity: payload.quantity,
          price: payload.price,
        }),
      };
    } catch (error: unknown) {
      return { error: messageOf(error) };
    }
  }

  private async adjustPreview(message: Record<string, unknown>): Promise<void> {
    if (typeof message.requestId !== 'number') {
      return;
    }
    const payload = readAdjustmentPayload(message);
    if (!payload) {
      return;
    }
    const base = {
      type: 'adjustPreviewResult',
      requestId: message.requestId,
      symbol: payload.symbol,
    };
    const outcome = this.computeAdjustment(payload);
    if ('error' in outcome) {
      void this.panel?.webview.postMessage({
        ...base,
        ok: false,
        message: outcome.error,
      });
      return;
    }
    void this.panel?.webview.postMessage({
      ...base,
      ok: true,
      quantity: outcome.result.quantity,
      averageCost: outcome.result.averageCost,
      previousAverageCost: outcome.before.averageCost,
      realizedProfit: outcome.result.realizedProfit,
      cleared: outcome.result.cleared,
    });
  }

  private async adjustApply(message: Record<string, unknown>): Promise<void> {
    const payload = readAdjustmentPayload(message);
    if (!payload) {
      return;
    }
    const outcome = this.computeAdjustment(payload);
    if ('error' in outcome) {
      void this.panel?.webview.postMessage({
        type: 'operationError',
        message: outcome.error,
      });
      return;
    }
    const draft = [...this.currentDraft()];
    const index = draft.findIndex((row) => row.symbol === payload.symbol);
    if (index === -1) {
      return;
    }
    const { before, result } = outcome;
    if (result.cleared) {
      draft.splice(index, 1);
    } else {
      draft[index] = {
        ...draft[index],
        quantity: String(result.quantity),
        averageCost: String(result.averageCost),
      };
    }
    this.draft = draft;
    this.dirty = true;
    this.postState(adjustmentMessage(payload, before, result));
  }

  private async saveCurrentDraft(notifyPanel: boolean): Promise<boolean> {
    const draft = this.draft;
    if (!draft) {
      return true;
    }
    try {
      const before = this.options.repository.getSnapshot().holdings;
      const holdings = materializeHoldingDraft(
        draft,
        before,
        this.allowedNewInstruments,
        randomUUID,
      );
      await this.options.repository.replaceHoldings(holdings);
      const previousSymbols = new Set(before.map((holding) => holding.symbol));
      const added = holdings.filter((holding) => !previousSymbols.has(holding.symbol));
      this.draft = toDraftInputs(holdings);
      this.dirty = false;
      this.allowedNewInstruments.clear();
      const afterSave = this.options.afterSave(added);
      if (notifyPanel) {
        this.postState('持仓已保存', true);
      }
      window.setStatusBarMessage('FishStock: 持仓已保存', 2_500);
      void afterSave.catch(async (error: unknown) => {
        await window.showWarningMessage(`FishStock: ${messageOf(error)}`);
      });
      return true;
    } catch (error: unknown) {
      if (notifyPanel) {
        void this.panel?.webview.postMessage({
          type: 'saveError',
          message: messageOf(error),
        });
      }
      return false;
    }
  }

  private async confirmUnsavedDraft(): Promise<void> {
    const choice = await window.showWarningMessage(
      '持仓管理中有未保存的更改。',
      {
        modal: true,
        detail: '可以保存全部更改、重新打开继续编辑，或放弃草稿。',
      },
      '保存',
      '继续编辑',
      '放弃',
    );
    if (choice === '保存') {
      const saved = await this.saveCurrentDraft(false);
      if (!saved) {
        await window.showWarningMessage('FishStock: 草稿中仍有无效行，请继续编辑后保存。');
        this.show();
      }
      return;
    }
    if (choice === '继续编辑') {
      this.show();
      return;
    }
    if (choice === '放弃') {
      this.draft = undefined;
      this.dirty = false;
      this.allowedNewInstruments.clear();
    }
  }

  private async openQuote(value: unknown): Promise<void> {
    if (typeof value !== 'string') {
      return;
    }
    const url = buildQuoteUrl(value);
    if (!url) {
      await window.showInformationMessage(`FishStock: ${value} 暂不支持行情页跳转`);
      return;
    }
    await env.openExternal(Uri.parse(url));
  }

  private html(): string {
    const nonce = randomUUID().replaceAll('-', '');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>FishStock 持仓管理</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px 28px 36px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    button, input { font: inherit; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 6px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button.danger { color: var(--vscode-errorForeground); background: transparent; border-color: var(--vscode-inputValidation-errorBorder); }
    button:disabled { cursor: default; opacity: .55; }
    input[type="search"], input[type="number"] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 6px 8px; outline: none; }
    input:focus { border-color: var(--vscode-focusBorder); }
    input.invalid { border-color: var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
    .subtitle, .muted { color: var(--vscode-descriptionForeground); }
    .summary { white-space: nowrap; padding-top: 5px; color: var(--vscode-descriptionForeground); }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); margin-bottom: 18px; }
    .search-card { padding: 16px; }
    .add-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .tab { padding: 5px 14px; font-size: 12px; }
    .tab:not(.active) { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .tab:not(.active):hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .search-row { display: flex; gap: 8px; }
    #searchInput { flex: 1; min-width: 180px; }
    #searchStatus { min-height: 20px; margin-top: 8px; color: var(--vscode-descriptionForeground); }
    .search-results { display: grid; gap: 6px; margin-top: 10px; }
    .search-result { display: grid; grid-template-columns: 22px minmax(160px, 1fr) auto; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editor-background); }
    .search-result.disabled { opacity: .6; }
    .search-result strong { display: block; font-weight: 500; }
    .result-meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .search-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    .toolbar .spacer { flex: 1; }
    #dirtyBadge { color: var(--vscode-descriptionForeground); }
    #dirtyBadge.dirty { color: var(--vscode-notificationsWarningIcon-foreground); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 1180px; border-collapse: collapse; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--vscode-panel-border); text-align: right; vertical-align: middle; }
    th { position: sticky; top: 0; z-index: 1; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); font-size: 12px; font-weight: 500; }
    th:first-child, td:first-child { width: 38px; text-align: center; }
    th:nth-child(2), td:nth-child(2) { min-width: 180px; text-align: left; }
    th:nth-child(3), td:nth-child(3) { text-align: left; }
    td input[type="number"] { width: 112px; text-align: right; }
    .instrument { padding: 0; color: var(--vscode-textLink-foreground); background: transparent; border: 0; cursor: pointer; }
    .instrument:hover { text-decoration: underline; }
    .symbol { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .state { display: inline-block; border-radius: 10px; padding: 2px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
    tfoot td { border-bottom: 0; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    tfoot .total-label { font-weight: 500; }
    tfoot .muted { font-size: 12px; }
    .state.stale, .state.error, .state.missing { color: var(--vscode-notificationsWarningIcon-foreground); background: transparent; border: 1px solid currentColor; }
    .up { color: var(--vscode-charts-red); }
    .down { color: var(--vscode-charts-green); }
    body.international .up { color: var(--vscode-charts-green); }
    body.international .down { color: var(--vscode-charts-red); }
    .row-action { padding: 3px 9px; font-size: 12px; }
    .adjust-row > td { padding: 0 10px 14px; background: var(--vscode-editor-background); }
    .adjust-panel { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px; padding: 12px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    .adjust-field { display: flex; flex-direction: column; gap: 4px; min-width: 92px; }
    .adjust-field > span { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .adjust-field input, .adjust-field select { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 5px 8px; outline: none; }
    .adjust-field input:focus, .adjust-field select:focus { border-color: var(--vscode-focusBorder); }
    .adjust-field input.invalid { border-color: var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); }
    .adjust-preview { flex: 1 1 260px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.7; }
    .adjust-preview strong { color: var(--vscode-foreground); font-weight: 500; }
    .adjust-preview.is-error { color: var(--vscode-errorForeground); }
    .adjust-hint { flex: 1 1 100%; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.7; }
    .adjust-actions { display: flex; gap: 8px; }
    .empty { padding: 42px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
    .notice { min-height: 22px; padding: 0 14px 10px; color: var(--vscode-descriptionForeground); }
    .notice.error { color: var(--vscode-errorForeground); }
    footer { color: var(--vscode-descriptionForeground); line-height: 1.6; }
    @media (max-width: 720px) { body { padding: 18px 14px 28px; } header { display: block; } .summary { margin-top: 8px; } .search-row { flex-wrap: wrap; } #searchInput { flex-basis: 100%; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>持仓管理</h1>
      <div class="subtitle">集中添加和修改多只持仓，确认后一次保存到当前 VS Code Profile。</div>
    </div>
    <div id="summary" class="summary">0 项持仓</div>
  </header>

  <section class="card search-card" aria-label="添加持仓">
    <div class="add-tabs" role="tablist" aria-label="添加方式">
      <button id="tabSearch" class="tab active" type="button" role="tab" aria-selected="true">搜索标的</button>
      <button id="tabWatchlist" class="tab" type="button" role="tab" aria-selected="false">从自选股添加</button>
    </div>
    <div id="searchPane">
      <div class="search-row">
        <input id="searchInput" type="search" autocomplete="off" placeholder="搜索 A 股、港股或境内 ETF 的名称、简称或代码">
        <button id="searchButton" type="button">搜索</button>
      </div>
      <div id="searchStatus">可连续搜索并勾选多个结果，再统一填写数量与平均成本。</div>
      <div id="searchResults" class="search-results"></div>
      <div id="searchActions" class="search-actions" hidden>
        <button id="addSelectedButton" type="button" disabled>添加所选标的</button>
      </div>
    </div>
    <div id="watchlistPane" hidden>
      <div id="watchlistStatus">从股票与 ETF 自选中勾选标的，批量加入下方表格。</div>
      <div id="watchlistResults" class="search-results"></div>
      <div id="watchlistActions" class="search-actions" hidden>
        <button id="watchlistSelectAllButton" class="secondary" type="button">全选</button>
        <button id="addWatchlistButton" type="button" disabled>添加所选标的</button>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="toolbar">
      <span id="dirtyBadge">没有未保存更改</span>
      <span class="spacer"></span>
      <button id="refreshButton" class="secondary" type="button">刷新行情</button>
      <button id="discardButton" class="secondary" type="button" disabled>放弃更改</button>
      <button id="deleteButton" class="danger" type="button" disabled>删除所选</button>
      <button id="saveButton" type="button" disabled>保存全部</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><input id="selectAll" type="checkbox" aria-label="选择全部持仓"></th>
            <th>名称 / 代码</th>
            <th>市场</th>
            <th>数量</th>
            <th>平均成本</th>
            <th>现价</th>
            <th>市值</th>
            <th>浮动盈亏</th>
            <th>收益率</th>
            <th>当日盈亏</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
        <tfoot id="totals"></tfoot>
      </table>
      <div id="emptyState" class="empty">暂无持仓。请搜索标的或从自选股批量添加。</div>
    </div>
    <div id="notice" class="notice"></div>
  </section>

  <footer>人民币与港币分别计算，不进行汇率换算。浮动盈亏未计入手续费、税费、分红或公司行动影响；当日盈亏按表中当前数量估算，未计入当日交易与费用，非交易日或行情不属于当日时显示 —。休市或过期行情会保留状态标识。调仓按移动加权平均成本计算：加仓摊薄成本，减仓只改数量且成本不变。</footer>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rowsElement = document.getElementById('rows');
    const totalsElement = document.getElementById('totals');
    const emptyState = document.getElementById('emptyState');
    const summary = document.getElementById('summary');
    const dirtyBadge = document.getElementById('dirtyBadge');
    const notice = document.getElementById('notice');
    const searchInput = document.getElementById('searchInput');
    const searchButton = document.getElementById('searchButton');
    const searchStatus = document.getElementById('searchStatus');
    const searchResultsElement = document.getElementById('searchResults');
    const searchActions = document.getElementById('searchActions');
    const addSelectedButton = document.getElementById('addSelectedButton');
    const tabSearch = document.getElementById('tabSearch');
    const tabWatchlist = document.getElementById('tabWatchlist');
    const searchPane = document.getElementById('searchPane');
    const watchlistPane = document.getElementById('watchlistPane');
    const watchlistStatus = document.getElementById('watchlistStatus');
    const watchlistResultsElement = document.getElementById('watchlistResults');
    const watchlistActions = document.getElementById('watchlistActions');
    const watchlistSelectAllButton = document.getElementById('watchlistSelectAllButton');
    const addWatchlistButton = document.getElementById('addWatchlistButton');
    const refreshButton = document.getElementById('refreshButton');
    const discardButton = document.getElementById('discardButton');
    const deleteButton = document.getElementById('deleteButton');
    const saveButton = document.getElementById('saveButton');
    const selectAll = document.getElementById('selectAll');
    const selectedRows = new Set();
    const selectedResults = new Set();
    const selectedWatchlist = new Set();
    let rows = [];
    let searchResults = [];
    let watchlistEntries = [];
    let activePane = 'search';
    let dirty = false;
    let busy = false;
    let requestId = 0;
    let latestRequestId = 0;
    let searchTimer;
    let colorConvention = 'china';
    let openAdjustSymbol = '';
    let adjustState = null;
    let adjustCanApply = false;
    let adjustPreviewId = 0;
    let latestAdjustPreviewId = 0;
    let adjustTimer;

    function rowKey(row) {
      return row.id ? 'id:' + row.id : 'new:' + row.symbol;
    }

    function closeAdjustPanel() {
      clearTimeout(adjustTimer);
      openAdjustSymbol = '';
      adjustState = null;
      adjustCanApply = false;
    }

    function adjustPreviewText(message) {
      if (!message.ok) return message.message || '无法计算';
      const quantity = formatNumber(message.quantity, 0, 0);
      if (adjustState && adjustState.direction === 'sell') {
        const realized = '已实现盈亏 ' + (message.realizedProfit >= 0 ? '+' : '-') + formatNumber(Math.abs(message.realizedProfit), 2, 2) + ' 不计入';
        if (message.cleared) return '新数量 0 · 保存后移除该持仓 · ' + realized;
        return '新数量 ' + quantity + ' · 平均成本保持 ' + formatNumber(message.averageCost, 2, 4) + ' · ' + realized;
      }
      return '新数量 ' + quantity + ' · 平均成本 ' + formatNumber(message.previousAverageCost, 2, 4) + ' → ' + formatNumber(message.averageCost, 2, 4);
    }

    function requestAdjustPreview() {
      if (!adjustState) return;
      adjustPreviewId += 1;
      latestAdjustPreviewId = adjustPreviewId;
      vscode.postMessage({
        type: 'adjustPreview',
        requestId: adjustPreviewId,
        symbol: adjustState.symbol,
        direction: adjustState.direction,
        quantity: adjustState.quantity,
        price: adjustState.price
      });
    }

    function scheduleAdjustPreview() {
      clearTimeout(adjustTimer);
      adjustTimer = setTimeout(requestAdjustPreview, 150);
    }

    function buildAdjustRow(row) {
      const tr = document.createElement('tr');
      tr.className = 'adjust-row';
      const td = document.createElement('td');
      td.colSpan = 11;
      const panel = document.createElement('div');
      panel.className = 'adjust-panel';

      const directionField = document.createElement('div');
      directionField.className = 'adjust-field';
      const directionLabel = document.createElement('span');
      directionLabel.textContent = '方向';
      const directionSelect = document.createElement('select');
      const buyOption = document.createElement('option');
      buyOption.value = 'buy';
      buyOption.textContent = '买入';
      const sellOption = document.createElement('option');
      sellOption.value = 'sell';
      sellOption.textContent = '卖出';
      directionSelect.append(buyOption, sellOption);
      directionSelect.value = adjustState.direction;
      directionSelect.setAttribute('aria-label', row.name + ' 调仓方向');
      directionSelect.addEventListener('change', function () {
        adjustState.direction = directionSelect.value;
        requestAdjustPreview();
      });
      directionField.append(directionLabel, directionSelect);

      const quantityField = document.createElement('div');
      quantityField.className = 'adjust-field';
      const quantityLabel = document.createElement('span');
      quantityLabel.textContent = '变动数量';
      const quantityInput = document.createElement('input');
      quantityInput.type = 'number';
      quantityInput.min = '1';
      quantityInput.step = '1';
      quantityInput.value = adjustState.quantity;
      quantityInput.setAttribute('aria-label', row.name + ' 调仓变动数量');
      quantityInput.addEventListener('input', function () {
        adjustState.quantity = quantityInput.value;
        scheduleAdjustPreview();
      });
      quantityField.append(quantityLabel, quantityInput);

      const priceField = document.createElement('div');
      priceField.className = 'adjust-field';
      const priceLabel = document.createElement('span');
      priceLabel.textContent = '成交价';
      const priceInput = document.createElement('input');
      priceInput.type = 'number';
      priceInput.min = '0';
      priceInput.step = 'any';
      priceInput.value = adjustState.price;
      priceInput.setAttribute('aria-label', row.name + ' 调仓成交价');
      priceInput.addEventListener('input', function () {
        adjustState.price = priceInput.value;
        scheduleAdjustPreview();
      });
      priceField.append(priceLabel, priceInput);

      const preview = document.createElement('div');
      preview.className = 'adjust-preview';
      preview.dataset.role = 'adjustPreview';
      preview.textContent = '填写变动数量和成交价后显示新的数量与平均成本。';

      const actions = document.createElement('div');
      actions.className = 'adjust-actions';
      const applyButton = document.createElement('button');
      applyButton.type = 'button';
      applyButton.textContent = '应用';
      applyButton.disabled = !adjustCanApply || busy;
      applyButton.addEventListener('click', function () {
        if (!adjustState) return;
        vscode.postMessage({
          type: 'adjustApply',
          symbol: adjustState.symbol,
          direction: adjustState.direction,
          quantity: adjustState.quantity,
          price: adjustState.price
        });
      });
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'secondary';
      cancelButton.textContent = '取消';
      cancelButton.addEventListener('click', function () {
        closeAdjustPanel();
        renderRows();
      });
      actions.append(applyButton, cancelButton);

      const hint = document.createElement('div');
      hint.className = 'adjust-hint';
      hint.textContent = '加仓按数量加权摊薄平均成本；减仓只改数量、平均成本不变。已实现盈亏不计入，FishStock 不记录交易流水。';

      const panelKeyDown = function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!applyButton.disabled) applyButton.click();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelButton.click();
        }
      };
      quantityInput.addEventListener('keydown', panelKeyDown);
      priceInput.addEventListener('keydown', panelKeyDown);

      panel.append(directionField, quantityField, priceField, preview, actions, hint);
      td.appendChild(panel);
      tr.appendChild(td);
      if (adjustState.quantity !== '' && adjustState.price !== '') {
        scheduleAdjustPreview();
      }
      return tr;
    }

    function formatNumber(value, minimumFractionDigits, maximumFractionDigits) {
      if (!Number.isFinite(value)) return '—';
      return value.toLocaleString('zh-CN', {
        minimumFractionDigits: minimumFractionDigits,
        maximumFractionDigits: maximumFractionDigits
      });
    }

    function parseQuantity(value) {
      const number = Number(String(value).trim());
      return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    function parseCost(value) {
      const number = Number(String(value).trim());
      return Number.isFinite(number) && number > 0 ? number : null;
    }

    function serializeRows() {
      return rows.map(function (row) {
        const payload = {
          symbol: row.symbol,
          quantity: row.quantity,
          averageCost: row.averageCost
        };
        if (row.id) payload.id = row.id;
        return payload;
      });
    }

    function postDraft() {
      vscode.postMessage({ type: 'draftChanged', rows: serializeRows() });
    }

    function markDirty() {
      dirty = true;
      updateControls();
      postDraft();
    }

    function validationError(row) {
      if (parseQuantity(row.quantity) === null) return '数量必须是正整数';
      if (parseCost(row.averageCost) === null) return '平均成本必须大于 0';
      return '';
    }

    function hasInvalidRows() {
      return rows.some(function (row) { return validationError(row); });
    }

    function updateControls() {
      const cny = rows.filter(function (row) { return row.currency === 'CNY'; }).length;
      const hkd = rows.length - cny;
      summary.textContent = rows.length + ' 项持仓 · CNY ' + cny + ' · HKD ' + hkd;
      dirtyBadge.textContent = dirty ? '有未保存更改' : '没有未保存更改';
      dirtyBadge.classList.toggle('dirty', dirty);
      discardButton.disabled = !dirty || busy;
      deleteButton.disabled = selectedRows.size === 0 || busy;
      saveButton.disabled = !dirty || hasInvalidRows() || busy;
      refreshButton.disabled = busy;
      searchButton.disabled = busy;
      selectAll.checked = rows.length > 0 && selectedRows.size === rows.length;
      selectAll.indeterminate = selectedRows.size > 0 && selectedRows.size < rows.length;
    }

    function setNotice(message, isError) {
      notice.textContent = message || '';
      notice.classList.toggle('error', Boolean(isError));
    }

    function updateMetrics(row, tr) {
      const quantity = parseQuantity(row.quantity);
      const cost = parseCost(row.averageCost);
      const canCalculate = quantity !== null && cost !== null && Number.isFinite(row.currentPrice) && row.currentPrice > 0 && row.quoteState !== 'error' && row.quoteState !== 'missing';
      const marketValueCell = tr.querySelector('[data-field="marketValue"]');
      const profitCell = tr.querySelector('[data-field="profit"]');
      const returnCell = tr.querySelector('[data-field="return"]');
      const dayProfitCell = tr.querySelector('[data-field="dayProfit"]');
      profitCell.classList.remove('up', 'down');
      returnCell.classList.remove('up', 'down');
      dayProfitCell.classList.remove('up', 'down');
      if (!canCalculate) {
        marketValueCell.textContent = '—';
        profitCell.textContent = '—';
        returnCell.textContent = '—';
        dayProfitCell.textContent = '—';
        return;
      }
      const costValue = quantity * cost;
      const marketValue = quantity * row.currentPrice;
      const profit = marketValue - costValue;
      const percent = profit / costValue * 100;
      marketValueCell.textContent = formatNumber(marketValue, 2, 2) + ' ' + row.currency;
      profitCell.textContent = (profit >= 0 ? '+' : '') + formatNumber(profit, 2, 2);
      returnCell.textContent = (percent >= 0 ? '+' : '') + formatNumber(percent, 2, 2) + '%';
      const className = profit > 0 ? 'up' : profit < 0 ? 'down' : '';
      if (className) {
        profitCell.classList.add(className);
        returnCell.classList.add(className);
      }
      const dayProfit = Number.isFinite(row.dayChange) ? quantity * row.dayChange : null;
      if (dayProfit === null) {
        dayProfitCell.textContent = '—';
      } else {
        dayProfitCell.textContent = (dayProfit >= 0 ? '+' : '') + formatNumber(dayProfit, 2, 2);
        const dayClassName = dayProfit > 0 ? 'up' : dayProfit < 0 ? 'down' : '';
        if (dayClassName) {
          dayProfitCell.classList.add(dayClassName);
        }
      }
    }

    function updateQuoteCells(row, tr) {
      const priceCell = tr.querySelector('[data-field="currentPrice"]');
      const state = tr.querySelector('.state');
      priceCell.textContent = Number.isFinite(row.currentPrice) ? formatNumber(row.currentPrice, 2, 4) + ' ' + row.currency : '—';
      state.className = 'state ' + row.quoteState;
      state.textContent = row.quoteStateLabel;
      updateMetrics(row, tr);
    }

    function createCell(text) {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    }

    function blankCell() {
      return document.createElement('td');
    }

    function signedNumber(value) {
      return (value >= 0 ? '+' : '') + formatNumber(value, 2, 2);
    }

    function signedPercent(value) {
      return (value >= 0 ? '+' : '') + formatNumber(value, 2, 2) + '%';
    }

    function toneCell(text, value) {
      const cell = createCell(text);
      if (value > 0) cell.classList.add('up');
      if (value < 0) cell.classList.add('down');
      return cell;
    }

    function totalLabel(text) {
      const span = document.createElement('span');
      span.className = 'total-label';
      span.textContent = text;
      return span;
    }

    function mutedNote(text) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = text;
      return span;
    }

    function renderTotals() {
      totalsElement.replaceChildren();
      const groups = new Map();
      rows.forEach(function (row) {
        const currency = row.currency === 'HKD' ? 'HKD' : 'CNY';
        if (!groups.has(currency)) {
          groups.set(currency, {
            currency: currency,
            itemCount: 0,
            pending: 0,
            costValue: 0,
            marketValue: 0,
            dayProfit: null,
            dayCount: 0,
          });
        }
        const group = groups.get(currency);
        group.itemCount += 1;
        const quantity = parseQuantity(row.quantity);
        const cost = parseCost(row.averageCost);
        const priced = Number.isFinite(row.currentPrice)
          && row.currentPrice > 0
          && row.quoteState !== 'error'
          && row.quoteState !== 'missing';
        if (quantity === null || cost === null || !priced) {
          group.pending += 1;
          return;
        }
        group.costValue += quantity * cost;
        group.marketValue += quantity * row.currentPrice;
        if (Number.isFinite(row.dayChange)) {
          group.dayProfit = (group.dayProfit === null ? 0 : group.dayProfit) + quantity * row.dayChange;
          group.dayCount += 1;
        }
      });
      groups.forEach(function (group) {
        const priced = group.costValue > 0;
        const profit = group.marketValue - group.costValue;
        const pricedCount = group.itemCount - group.pending;
        const tr = document.createElement('tr');
        tr.appendChild(blankCell());
        const labelCell = document.createElement('td');
        labelCell.appendChild(totalLabel('合计 ' + group.currency));
        if (group.pending > 0) {
          labelCell.appendChild(mutedNote(' · ' + group.pending + ' 项待填写'));
        }
        tr.appendChild(labelCell);
        for (let index = 0; index < 4; index += 1) {
          tr.appendChild(blankCell());
        }
        tr.appendChild(createCell(priced ? formatNumber(group.marketValue, 2, 2) + ' ' + group.currency : '—'));
        tr.appendChild(toneCell(priced ? signedNumber(profit) : '—', priced ? profit : 0));
        tr.appendChild(toneCell(priced ? signedPercent(profit / group.costValue * 100) : '—', priced ? profit : 0));
        const dayCell = toneCell(
          group.dayProfit === null ? '—' : signedNumber(group.dayProfit),
          group.dayProfit === null ? 0 : group.dayProfit,
        );
        if (group.dayProfit !== null && group.dayCount < pricedCount) {
          dayCell.title = '仅 ' + group.dayCount + ' 项有当日行情';
        }
        tr.appendChild(dayCell);
        tr.appendChild(blankCell());
        tr.appendChild(blankCell());
        totalsElement.appendChild(tr);
      });
    }

    function renderRows(focus) {
      rowsElement.replaceChildren();
      emptyState.hidden = rows.length > 0;
      const validKeys = new Set(rows.map(rowKey));
      Array.from(selectedRows).forEach(function (key) {
        if (!validKeys.has(key)) selectedRows.delete(key);
      });

      rows.forEach(function (row) {
        const tr = document.createElement('tr');
        tr.dataset.key = rowKey(row);

        const selectCell = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedRows.has(rowKey(row));
        checkbox.setAttribute('aria-label', '选择 ' + row.name);
        checkbox.addEventListener('change', function () {
          if (checkbox.checked) selectedRows.add(rowKey(row));
          else selectedRows.delete(rowKey(row));
          updateControls();
        });
        selectCell.appendChild(checkbox);
        tr.appendChild(selectCell);

        const instrumentCell = document.createElement('td');
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'instrument';
        name.textContent = row.name;
        name.addEventListener('click', function () {
          vscode.postMessage({ type: 'openQuote', symbol: row.symbol });
        });
        const symbol = document.createElement('div');
        symbol.className = 'symbol';
        symbol.textContent = row.symbol + (row.kind === 'fund' ? ' · ETF' : ' · 股票');
        instrumentCell.append(name, symbol);
        tr.appendChild(instrumentCell);

        tr.appendChild(createCell(row.market === 'HK' ? '港股 / HKD' : 'A 股 / CNY'));

        const quantityCell = document.createElement('td');
        const quantityInput = document.createElement('input');
        quantityInput.type = 'number';
        quantityInput.min = '1';
        quantityInput.step = '1';
        quantityInput.value = String(row.quantity ?? '');
        quantityInput.dataset.role = 'quantity';
        quantityInput.setAttribute('aria-label', row.name + ' 持有数量');
        quantityInput.addEventListener('input', function () {
          row.quantity = quantityInput.value;
          quantityInput.classList.toggle('invalid', parseQuantity(row.quantity) === null);
          quantityInput.title = parseQuantity(row.quantity) === null ? '请输入大于 0 的整数' : '';
          markDirty();
          updateMetrics(row, tr);
          renderTotals();
        });
        quantityCell.appendChild(quantityInput);
        tr.appendChild(quantityCell);

        const costCell = document.createElement('td');
        const costInput = document.createElement('input');
        costInput.type = 'number';
        costInput.min = '0';
        costInput.step = 'any';
        costInput.value = String(row.averageCost ?? '');
        costInput.dataset.role = 'cost';
        costInput.setAttribute('aria-label', row.name + ' 平均成本');
        costInput.addEventListener('input', function () {
          row.averageCost = costInput.value;
          costInput.classList.toggle('invalid', parseCost(row.averageCost) === null);
          costInput.title = parseCost(row.averageCost) === null ? '请输入大于 0 的数字' : '';
          markDirty();
          updateMetrics(row, tr);
          renderTotals();
        });
        costCell.appendChild(costInput);
        tr.appendChild(costCell);

        const currentPriceCell = createCell('—');
        currentPriceCell.dataset.field = 'currentPrice';
        tr.appendChild(currentPriceCell);
        const marketValueCell = createCell('—');
        marketValueCell.dataset.field = 'marketValue';
        tr.appendChild(marketValueCell);
        const profitCell = createCell('—');
        profitCell.dataset.field = 'profit';
        tr.appendChild(profitCell);
        const returnCell = createCell('—');
        returnCell.dataset.field = 'return';
        tr.appendChild(returnCell);
        const dayProfitCell = createCell('—');
        dayProfitCell.dataset.field = 'dayProfit';
        tr.appendChild(dayProfitCell);
        const stateCell = document.createElement('td');
        const state = document.createElement('span');
        state.className = 'state ' + row.quoteState;
        state.textContent = row.quoteStateLabel;
        stateCell.appendChild(state);
        tr.appendChild(stateCell);

        const actionCell = document.createElement('td');
        const adjustButton = document.createElement('button');
        adjustButton.type = 'button';
        adjustButton.className = 'secondary row-action';
        adjustButton.textContent = '调仓';
        const rowReady = parseQuantity(row.quantity) !== null && parseCost(row.averageCost) !== null;
        adjustButton.disabled = !rowReady || busy;
        adjustButton.title = rowReady
          ? '记录一次买入或卖出，并重算平均成本'
          : '请先填写有效的数量和平均成本';
        adjustButton.addEventListener('click', function () {
          const alreadyOpen = openAdjustSymbol === row.symbol;
          closeAdjustPanel();
          if (!alreadyOpen) {
            openAdjustSymbol = row.symbol;
            adjustState = { symbol: row.symbol, direction: 'buy', quantity: '', price: '' };
          }
          renderRows();
        });
        actionCell.appendChild(adjustButton);
        tr.appendChild(actionCell);

        rowsElement.appendChild(tr);
        if (openAdjustSymbol === row.symbol && adjustState) {
          rowsElement.appendChild(buildAdjustRow(row));
        }
        quantityInput.classList.toggle('invalid', parseQuantity(row.quantity) === null);
        costInput.classList.toggle('invalid', parseCost(row.averageCost) === null);
        updateQuoteCells(row, tr);
      });

      renderTotals();
      updateControls();
      if (focus && focus.type === 'holding') {
        const target = rows.find(function (row) { return row.id === focus.holdingId; });
        if (target) {
          const tr = rowsElement.querySelector('[data-key="' + CSS.escape(rowKey(target)) + '"]');
          const input = tr && tr.querySelector('[data-role="quantity"]');
          if (input) {
            input.focus();
            input.select();
            tr.scrollIntoView({ block: 'center' });
          }
        }
      }
    }

    function renderSearchResults() {
      searchResultsElement.replaceChildren();
      const existingSymbols = new Set(rows.map(function (row) { return row.symbol; }));
      searchResults.forEach(function (result) {
        const alreadyAdded = existingSymbols.has(result.symbol);
        const label = document.createElement('label');
        label.className = 'search-result' + (alreadyAdded ? ' disabled' : '');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = alreadyAdded;
        checkbox.checked = selectedResults.has(result.symbol) && !alreadyAdded;
        checkbox.addEventListener('change', function () {
          if (checkbox.checked) selectedResults.add(result.symbol);
          else selectedResults.delete(result.symbol);
          addSelectedButton.disabled = selectedResults.size === 0;
        });
        const title = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = result.name;
        const meta = document.createElement('div');
        meta.className = 'result-meta';
        meta.textContent = result.symbol + ' · ' + (result.kind === 'fund' ? 'ETF' : '股票') + (result.abbreviation ? ' · ' + result.abbreviation.toUpperCase() : '');
        title.append(strong, meta);
        const status = document.createElement('span');
        status.className = 'muted';
        status.textContent = alreadyAdded ? '已在表格中' : result.quoteStateLabel;
        label.append(checkbox, title, status);
        searchResultsElement.appendChild(label);
      });
      searchActions.hidden = searchResults.length === 0;
      addSelectedButton.disabled = selectedResults.size === 0;
    }

    function runSearch() {
      const query = searchInput.value.trim();
      if (!query) {
        searchStatus.textContent = '请输入名称、简称或代码。';
        return;
      }
      requestId += 1;
      latestRequestId = requestId;
      selectedResults.clear();
      searchStatus.textContent = '正在搜索…';
      searchResults = [];
      renderSearchResults();
      vscode.postMessage({ type: 'search', query: query, requestId: requestId });
    }

    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      if (!searchInput.value.trim()) return;
      searchTimer = setTimeout(runSearch, 350);
    });
    searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        clearTimeout(searchTimer);
        runSearch();
      }
    });
    searchButton.addEventListener('click', runSearch);

    function addInstruments(entries, selected) {
      const existingSymbols = new Set(rows.map(function (row) { return row.symbol; }));
      const added = entries.filter(function (entry) {
        return selected.has(entry.symbol) && !existingSymbols.has(entry.symbol);
      });
      added.forEach(function (entry) {
        rows.push(Object.assign({}, entry, { quantity: '', averageCost: '' }));
      });
      selected.clear();
      if (added.length > 0) {
        markDirty();
        renderRows();
        setNotice('已加入 ' + added.length + ' 项，请填写数量和平均成本后保存。', false);
        const first = rows.find(function (row) { return row.symbol === added[0].symbol; });
        const tr = first && rowsElement.querySelector('[data-key="' + CSS.escape(rowKey(first)) + '"]');
        const input = tr && tr.querySelector('[data-role="quantity"]');
        if (input) input.focus();
      }
      return added.length;
    }

    addSelectedButton.addEventListener('click', function () {
      if (addInstruments(searchResults, selectedResults) > 0) renderSearchResults();
    });

    function watchlistSelectable() {
      const existingSymbols = new Set(rows.map(function (row) { return row.symbol; }));
      return watchlistEntries.filter(function (entry) {
        return !existingSymbols.has(entry.symbol);
      });
    }

    function updateWatchlistControls() {
      const selectable = watchlistSelectable();
      const allSelected = selectable.length > 0 && selectable.every(function (entry) {
        return selectedWatchlist.has(entry.symbol);
      });
      watchlistSelectAllButton.textContent = allSelected ? '全不选' : '全选';
      watchlistSelectAllButton.disabled = selectable.length === 0 || busy;
      addWatchlistButton.disabled = selectedWatchlist.size === 0 || busy;
    }

    function renderWatchlistEntries() {
      watchlistResultsElement.replaceChildren();
      watchlistStatus.textContent = watchlistEntries.length === 0
        ? '股票与 ETF 自选中暂无可入持仓的标的；指数、期货与美股不在持仓范围。'
        : '共 ' + watchlistEntries.length + ' 项可添加，勾选后加入下方表格并填写数量与平均成本。';
      const existingSymbols = new Set(rows.map(function (row) { return row.symbol; }));
      watchlistEntries.forEach(function (entry) {
        const alreadyAdded = existingSymbols.has(entry.symbol);
        const label = document.createElement('label');
        label.className = 'search-result' + (alreadyAdded ? ' disabled' : '');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = alreadyAdded;
        checkbox.checked = selectedWatchlist.has(entry.symbol) && !alreadyAdded;
        checkbox.addEventListener('change', function () {
          if (checkbox.checked) selectedWatchlist.add(entry.symbol);
          else selectedWatchlist.delete(entry.symbol);
          updateWatchlistControls();
        });
        const title = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = entry.name;
        const meta = document.createElement('div');
        meta.className = 'result-meta';
        meta.textContent = entry.symbol + ' · ' + (entry.kind === 'fund' ? 'ETF' : '股票') + ' · ' + (entry.market === 'HK' ? '港股' : 'A 股');
        title.append(strong, meta);
        const status = document.createElement('span');
        status.className = 'muted';
        status.textContent = alreadyAdded
          ? '已在表格中'
          : (Number.isFinite(entry.currentPrice) ? formatNumber(entry.currentPrice, 2, 4) + ' ' + entry.currency : entry.quoteStateLabel);
        label.append(checkbox, title, status);
        watchlistResultsElement.appendChild(label);
      });
      watchlistActions.hidden = watchlistEntries.length === 0;
      updateWatchlistControls();
    }

    function activatePane(pane) {
      activePane = pane === 'watchlist' ? 'watchlist' : 'search';
      const isSearch = activePane === 'search';
      tabSearch.classList.toggle('active', isSearch);
      tabWatchlist.classList.toggle('active', !isSearch);
      tabSearch.setAttribute('aria-selected', String(isSearch));
      tabWatchlist.setAttribute('aria-selected', String(!isSearch));
      searchPane.hidden = !isSearch;
      watchlistPane.hidden = isSearch;
      if (isSearch) searchInput.focus();
      else renderWatchlistEntries();
    }

    tabSearch.addEventListener('click', function () { activatePane('search'); });
    tabWatchlist.addEventListener('click', function () {
      activatePane('watchlist');
      vscode.postMessage({ type: 'watchlist' });
    });

    function pruneWatchlistSelection(validSymbols) {
      Array.from(selectedWatchlist).forEach(function (symbol) {
        if (!validSymbols.has(symbol)) selectedWatchlist.delete(symbol);
      });
    }

    watchlistSelectAllButton.addEventListener('click', function () {
      const selectable = watchlistSelectable();
      const allSelected = selectable.length > 0 && selectable.every(function (entry) {
        return selectedWatchlist.has(entry.symbol);
      });
      if (allSelected) {
        selectable.forEach(function (entry) { selectedWatchlist.delete(entry.symbol); });
      } else {
        selectable.forEach(function (entry) { selectedWatchlist.add(entry.symbol); });
      }
      renderWatchlistEntries();
    });

    addWatchlistButton.addEventListener('click', function () {
      if (addInstruments(watchlistEntries, selectedWatchlist) > 0) renderWatchlistEntries();
    });

    selectAll.addEventListener('change', function () {
      selectedRows.clear();
      if (selectAll.checked) rows.forEach(function (row) { selectedRows.add(rowKey(row)); });
      renderRows();
    });

    deleteButton.addEventListener('click', function () {
      if (selectedRows.size === 0) return;
      const deleted = selectedRows.size;
      rows = rows.filter(function (row) { return !selectedRows.has(rowKey(row)); });
      selectedRows.clear();
      closeAdjustPanel();
      markDirty();
      renderRows();
      renderSearchResults();
      setNotice('已从草稿移除 ' + deleted + ' 项，保存后生效。', false);
    });

    discardButton.addEventListener('click', function () {
      vscode.postMessage({ type: 'discard' });
    });
    refreshButton.addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
    saveButton.addEventListener('click', function () {
      setNotice('正在保存…', false);
      vscode.postMessage({ type: 'save', rows: serializeRows() });
    });

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'state') {
        closeAdjustPanel();
        rows = Array.isArray(message.rows) ? message.rows : [];
        dirty = Boolean(message.dirty);
        if (message.clearSearch) {
          searchInput.value = '';
          searchResults = [];
          selectedResults.clear();
          searchStatus.textContent = '可连续搜索并勾选多个结果，再统一填写数量与平均成本。';
        }
        watchlistEntries = Array.isArray(message.watchlistEntries) ? message.watchlistEntries : [];
        selectedWatchlist.clear();
        colorConvention = message.colorConvention === 'international' ? 'international' : 'china';
        document.body.classList.toggle('international', colorConvention === 'international');
        selectedRows.clear();
        renderRows(message.focus);
        renderSearchResults();
        if (activePane === 'watchlist') renderWatchlistEntries();
        setNotice(message.message || '', false);
        if (message.focus && message.focus.type === 'search') activatePane('search');
        return;
      }
      if (message.type === 'adjustPreviewResult') {
        if (!adjustState || message.symbol !== adjustState.symbol) return;
        if (message.requestId !== latestAdjustPreviewId) return;
        const preview = rowsElement.querySelector('[data-role="adjustPreview"]');
        if (!preview) return;
        adjustCanApply = Boolean(message.ok);
        preview.classList.toggle('is-error', !message.ok);
        preview.textContent = adjustPreviewText(message);
        const applyButton = preview.parentElement.querySelector('.adjust-actions button');
        if (applyButton) applyButton.disabled = !message.ok || busy;
        return;
      }
      if (message.type === 'searchResults' && message.requestId === latestRequestId) {
        searchResults = Array.isArray(message.results) ? message.results : [];
        selectedResults.clear();
        searchStatus.textContent = searchResults.length > 0 ? '找到 ' + searchResults.length + ' 项，可多选添加。' : '未找到匹配的股票或境内 ETF。';
        renderSearchResults();
        return;
      }
      if (message.type === 'watchlistEntries' && Array.isArray(message.entries)) {
        watchlistEntries = message.entries;
        pruneWatchlistSelection(new Set(watchlistEntries.map(function (entry) { return entry.symbol; })));
        if (activePane === 'watchlist') renderWatchlistEntries();
        return;
      }
      if (message.type === 'quoteUpdate' && Array.isArray(message.quotes)) {
        colorConvention = message.colorConvention === 'international' ? 'international' : 'china';
        document.body.classList.toggle('international', colorConvention === 'international');
        const quotes = new Map(message.quotes.map(function (quote) { return [quote.symbol, quote]; }));
        rows.forEach(function (row) {
          const quote = quotes.get(row.symbol);
          if (!quote) return;
          row.currentPrice = quote.currentPrice;
          row.currency = quote.currency;
          row.quoteState = quote.quoteState;
          row.quoteStateLabel = quote.quoteStateLabel;
          row.dayChange = quote.dayChange;
          const tr = rowsElement.querySelector('[data-key="' + CSS.escape(rowKey(row)) + '"]');
          if (tr) updateQuoteCells(row, tr);
        });
        renderTotals();
        return;
      }
      if (message.type === 'searchError' && message.requestId === latestRequestId) {
        searchResults = [];
        searchStatus.textContent = '搜索失败：' + message.message;
        renderSearchResults();
        return;
      }
      if (message.type === 'busy') {
        busy = Boolean(message.value);
        updateControls();
        updateWatchlistControls();
        return;
      }
      if (message.type === 'saveError' || message.type === 'operationError') {
        setNotice(message.message || '操作失败', true);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
