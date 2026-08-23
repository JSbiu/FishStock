import { randomUUID } from 'node:crypto';
import {
  commands,
  env,
  ProgressLocation,
  Uri,
  window,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import { holdingCurrency } from '../domain/holdings';
import type {
  Holding,
  HoldingInstrumentKind,
  StockSearchResult,
} from '../domain/models';
import { buildQuoteUrl } from '../domain/quoteUrl';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import type { HoldingNode } from '../ui/holdingsTreeProvider';

export type HoldingSearchResult = StockSearchResult & {
  kind: HoldingInstrumentKind;
  market: 'CN' | 'HK';
};

export interface HoldingsCommandOptions {
  repository: HoldingsRepository;
  search(query: string): Promise<HoldingSearchResult[]>;
  refresh(manual: boolean): Promise<void>;
  afterChange(added?: Holding): Promise<void>;
}

interface HoldingPick extends QuickPickItem {
  holding: Holding;
}

interface SearchPick extends QuickPickItem {
  result: HoldingSearchResult;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function parseQuantity(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAverageCost(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function inputPosition(
  holding: Pick<Holding, 'market' | 'kind'>,
  current?: Pick<Holding, 'quantity' | 'averageCost'>,
): Promise<{ quantity: number; averageCost: number } | undefined> {
  const quantityText = await window.showInputBox({
    title: current ? '编辑持仓数量' : '输入持仓数量',
    prompt: holding.kind === 'fund' ? '持有份数（正整数）' : '持有股数（正整数）',
    ...(current ? { value: String(current.quantity) } : {}),
    validateInput: (value) => parseQuantity(value) === undefined
      ? '请输入大于 0 的整数'
      : undefined,
  });
  if (quantityText === undefined) {
    return undefined;
  }
  const quantity = parseQuantity(quantityText);
  if (quantity === undefined) {
    return undefined;
  }
  const currency = holdingCurrency({
    id: '',
    symbol: '',
    market: holding.market,
    kind: holding.kind,
    quantity,
    averageCost: 1,
  });
  const costText = await window.showInputBox({
    title: current ? '编辑平均成本' : '输入平均成本',
    prompt: `每股或每份平均成本（${currency}，不含费用调整）`,
    ...(current ? { value: String(current.averageCost) } : {}),
    validateInput: (value) => parseAverageCost(value) === undefined
      ? '请输入大于 0 的数字'
      : undefined,
  });
  if (costText === undefined) {
    return undefined;
  }
  const averageCost = parseAverageCost(costText);
  return averageCost === undefined ? undefined : { quantity, averageCost };
}

async function chooseHolding(
  repository: HoldingsRepository,
  provided?: HoldingNode,
): Promise<Holding | undefined> {
  if (provided) {
    return provided.holding;
  }
  const picked = await window.showQuickPick<HoldingPick>(
    repository.getSnapshot().holdings.map((holding) => ({
      label: holding.name ?? holding.symbol,
      description: `${holding.symbol} · ${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'}`,
      holding,
    })),
    { placeHolder: '选择持仓条目' },
  );
  return picked?.holding;
}

export function registerHoldingsCommands(
  options: HoldingsCommandOptions,
): Disposable[] {
  const handle = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error: unknown) {
      await window.showWarningMessage(`FishStock: ${messageOf(error)}`);
    }
  };

  return [
    commands.registerCommand('fishStock.addHolding', async () => {
      const query = await window.showInputBox({
        title: '添加持仓',
        prompt: '搜索 A 股、港股或境内 ETF',
        placeHolder: '输入名称、简称或代码，如 美的集团、mdjt、000333',
        validateInput: (value) => value.trim() ? undefined : '请输入名称、简称或代码',
      });
      if (!query) {
        return;
      }
      let results: HoldingSearchResult[];
      try {
        results = await window.withProgress(
          {
            location: ProgressLocation.Window,
            title: 'FishStock: 正在搜索持仓标的',
          },
          () => options.search(query.trim()),
        );
      } catch (error: unknown) {
        await window.showWarningMessage(`FishStock: 搜索失败：${messageOf(error)}`);
        return;
      }
      if (results.length === 0) {
        await window.showInformationMessage('FishStock: 未找到匹配的股票或境内 ETF');
        return;
      }
      const picked = await window.showQuickPick<SearchPick>(
        results.map((result) => ({
          label: result.name,
          description: `${result.symbol} · ${result.kind === 'fund' ? 'ETF' : '股票'}`,
          ...(result.abbreviation
            ? { detail: `简称：${result.abbreviation.toUpperCase()}` }
            : {}),
          result,
        })),
        {
          title: '选择持仓标的',
          placeHolder: results.length > 0
            ? '选择一项继续输入数量和成本'
            : '未找到匹配的股票或境内 ETF',
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!picked) {
        return;
      }
      const position = await inputPosition(picked.result);
      if (!position) {
        return;
      }
      await handle(async () => {
        const holding: Holding = {
          id: randomUUID(),
          symbol: picked.result.symbol,
          market: picked.result.market,
          kind: picked.result.kind,
          name: picked.result.name,
          ...position,
        };
        await options.repository.addHolding(holding);
        await options.afterChange(holding);
      });
    }),

    commands.registerCommand('fishStock.editHolding', async (node?: HoldingNode) => {
      const holding = await chooseHolding(options.repository, node);
      if (!holding) {
        return;
      }
      const position = await inputPosition(holding, holding);
      if (!position) {
        return;
      }
      await handle(async () => {
        await options.repository.updateHolding(
          holding.id,
          position.quantity,
          position.averageCost,
        );
        await options.afterChange();
      });
    }),

    commands.registerCommand('fishStock.removeHolding', async (node?: HoldingNode) => {
      const holding = await chooseHolding(options.repository, node);
      if (!holding) {
        return;
      }
      const answer = await window.showWarningMessage(
        `删除持仓 ${holding.name ?? holding.symbol}？`,
        { modal: true },
        '删除',
      );
      if (answer !== '删除') {
        return;
      }
      await handle(async () => {
        await options.repository.removeHolding(holding.id);
        await options.afterChange();
      });
    }),

    commands.registerCommand('fishStock.refreshHoldings', async () => {
      await handle(() => options.refresh(true));
    }),

    commands.registerCommand('fishStock.clearHoldings', async () => {
      const count = options.repository.getSnapshot().holdings.length;
      if (count === 0) {
        await window.showInformationMessage('FishStock: 持仓已经是空的');
        return;
      }
      const answer = await window.showWarningMessage(
        '清空全部持仓？',
        {
          modal: true,
          detail: `将删除 ${count} 个持仓条目的数量和平均成本。此操作无法撤销。`,
        },
        '清空持仓',
      );
      if (answer !== '清空持仓') {
        return;
      }
      await handle(async () => {
        await options.repository.clear();
        await options.afterChange();
        window.setStatusBarMessage('FishStock: 持仓已清空', 2_500);
      });
    }),

    commands.registerCommand('fishStock.openHoldings', async () => {
      await commands.executeCommand('workbench.view.extension.fishStock');
    }),

    commands.registerCommand('fishStock.openHoldingQuote', async (node?: HoldingNode) => {
      if (!node) {
        await window.showInformationMessage('FishStock: 请点击持仓条目打开行情页面');
        return;
      }
      const url = buildQuoteUrl(node.holding.symbol);
      if (!url) {
        await window.showInformationMessage(
          `FishStock: ${node.holding.symbol} 暂不支持行情页跳转`,
        );
        return;
      }
      await env.openExternal(Uri.parse(url));
    }),
  ];
}
