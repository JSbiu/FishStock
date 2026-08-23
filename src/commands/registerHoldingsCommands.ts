import {
  commands,
  env,
  Uri,
  window,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { Holding } from '../domain/models';
import { buildQuoteUrl } from '../domain/quoteUrl';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import type { HoldingsManagerFocus } from '../ui/holdingsManagerPanel';
import type { HoldingNode } from '../ui/holdingsTreeProvider';

export interface HoldingsCommandOptions {
  repository: HoldingsRepository;
  openManager(focus?: HoldingsManagerFocus): void;
  refresh(manual: boolean): Promise<void>;
  afterChange(added?: readonly Holding[]): Promise<void>;
}

interface HoldingPick extends QuickPickItem {
  holding: Holding;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
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
      options.openManager({ type: 'search' });
    }),

    commands.registerCommand('fishStock.manageHoldings', async () => {
      options.openManager();
    }),

    commands.registerCommand('fishStock.editHolding', async (node?: HoldingNode) => {
      const holding = await chooseHolding(options.repository, node);
      if (!holding) {
        return;
      }
      options.openManager({ type: 'holding', holdingId: holding.id });
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
