import {
  commands,
  ConfigurationTarget,
  env,
  Uri,
  window,
  workspace,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { Holding } from '../domain/models';
import {
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  ensureAtLeastOneField,
  HOLDING_SORT_LABELS,
  type HoldingDescriptionFields,
  type HoldingSortKey,
  type HoldingSortState,
} from '../domain/holdings';
import { buildQuoteUrl } from '../domain/quoteUrl';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import type { ViewOptionsStore } from '../storage/viewOptionsStore';
import type { HoldingsManagerFocus } from '../ui/holdingsManagerPanel';
import type { HoldingsTreeProvider, HoldingNode } from '../ui/holdingsTreeProvider';

export interface HoldingsCommandOptions {
  repository: HoldingsRepository;
  openManager(focus?: HoldingsManagerFocus): void;
  refresh(manual: boolean): Promise<void>;
  afterChange(added?: readonly Holding[]): Promise<void>;
  viewOptions: ViewOptionsStore;
  treeProvider: HoldingsTreeProvider;
}

interface HoldingPick extends QuickPickItem {
  holding: Holding;
}

const SORT_PICKS: ReadonlyArray<{
  description: string;
  key: HoldingSortKey;
}> = [
  { description: '手动调整的顺序', key: 'manual' },
  { description: '相对持仓成本', key: 'profitPercent' },
  { description: '累计盈亏金额', key: 'profitAmount' },
  { description: '相对昨收', key: 'dayPercent' },
  { description: '今天的盈亏金额', key: 'dayAmount' },
];

const FIELD_PICKS: ReadonlyArray<{
  label: string;
  description: string;
  key: keyof HoldingDescriptionFields;
}> = [
  { label: '数量', description: '持仓 /份数', key: 'quantity' },
  { label: '市值', description: '按万 / 亿压缩', key: 'marketValue' },
  { label: '浮动盈亏', description: '金额 + 相对成本收益率', key: 'profit' },
  { label: '当日盈亏', description: '今日金额 + 相对昨收百分比', key: 'dayProfit' },
];

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

  // 手动顺序只在「默认顺序」下有意义：其他排序维度会把手动顺序覆盖掉，
  // 此时调整不会有任何可见变化，因此直接挡掉而不是静默失败。
  const moveHolding = async (
    node: HoldingNode | undefined,
    delta: -1 | 1,
  ): Promise<void> => {
    if (options.viewOptions.getSnapshot().holdingsSort !== 'manual') {
      await window.showInformationMessage(
        'FishStock: 手动调整顺序只在「默认顺序」下可用，请先切回默认顺序。',
      );
      return;
    }
    const holding = await chooseHolding(options.repository, node);
    if (!holding) {
      return;
    }
    await handle(async () => {
      await options.repository.moveHolding(holding.id, delta);
      await options.afterChange();
    });
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

    commands.registerCommand('fishStock.selectHoldingsSort', async () => {
      const snapshot = options.viewOptions.getSnapshot();
      const current: HoldingSortState = {
        key: snapshot.holdingsSort,
        desc: snapshot.holdingsSortDesc,
      };
      const picked = await window.showQuickPick(
        SORT_PICKS.map((pick) => ({
          label: HOLDING_SORT_LABELS[pick.key],
          // 只在当前项上标方向，不再加「（当前）」这类括号备注——方向本身就是状态。
          description: pick.key === current.key && pick.key !== 'manual'
            ? (current.desc ? '从高到低' : '从低到高')
            : pick.description,
          key: pick.key,
        })),
        { placeHolder: '选择持仓排序方式（再次选择同一项可切换升 / 降序）' },
      );
      if (!picked) {
        return;
      }
      // 再次选择同一项 = 切换方向；换一项 = 应用新维度并回到默认的「从高到低」。
      const next: HoldingSortState = picked.key === current.key && picked.key !== 'manual'
        ? { key: picked.key, desc: !current.desc }
        : { key: picked.key, desc: true };
      if (next.key === current.key && next.desc === current.desc) {
        return;
      }
      await handle(async () => {
        await options.viewOptions.setHoldingSort(next);
        options.treeProvider.setSort(next);
      });
    }),

    commands.registerCommand('fishStock.moveHoldingUp', async (node?: HoldingNode) => {
      await moveHolding(node, -1);
    }),

    commands.registerCommand('fishStock.moveHoldingDown', async (node?: HoldingNode) => {
      await moveHolding(node, 1);
    }),

    commands.registerCommand('fishStock.selectHoldingsTreeViewFields', async () => {
      const config = workspace.getConfiguration('fishStock.holdings');
      const current = config.get<HoldingDescriptionFields>(
        'treeViewFields',
        DEFAULT_HOLDING_DESCRIPTION_FIELDS,
      );
      const picker = window.createQuickPick<{ label: string; description: string; key: keyof HoldingDescriptionFields }>();
      picker.placeholder = '选择 Holdings Tree View 描述行展示的字段（至少一项）';
      picker.canSelectMany = true;
      picker.items = FIELD_PICKS.map((pick) => ({
        label: pick.label,
        description: pick.description,
        key: pick.key,
      }));
      picker.selectedItems = picker.items.filter((item) => current[item.key]);
      const selected = await new Promise<ReadonlyArray<typeof picker.items[number]> | undefined>((resolve) => {
        let settled = false;
        const finish = (items: typeof picker.selectedItems): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(items);
          picker.hide();
          picker.dispose();
        };
        picker.onDidAccept(() => finish(picker.selectedItems));
        picker.onDidHide(() => finish(picker.selectedItems));
        picker.show();
      });
      if (!selected) {
        return;
      }
      const next: HoldingDescriptionFields = {
        quantity: selected.some((item) => item.key === 'quantity'),
        marketValue: selected.some((item) => item.key === 'marketValue'),
        profit: selected.some((item) => item.key === 'profit'),
        dayProfit: selected.some((item) => item.key === 'dayProfit'),
      };
      const ensured = ensureAtLeastOneField(next);
      const same =
        ensured.quantity === current.quantity
        && ensured.marketValue === current.marketValue
        && ensured.profit === current.profit
        && ensured.dayProfit === current.dayProfit;
      if (same) {
        return;
      }
      await handle(async () => {
        await config.update('treeViewFields', ensured, ConfigurationTarget.Global);
        options.treeProvider.setFieldFlags(ensured);
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
