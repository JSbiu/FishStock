import { randomUUID } from 'node:crypto';
import {
  commands,
  window,
  workspace,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { MarketDataProvider } from '../data/marketDataProvider';
import type { Stock, StockSearchResult, WatchGroup } from '../domain/models';
import {
  parseWatchlistState,
  type WatchlistRepository,
} from '../storage/watchlistRepository';
import type { GroupNode, StockNode } from '../ui/watchlistTreeProvider';

interface GroupPick extends QuickPickItem {
  group: WatchGroup;
}

interface StockPick extends QuickPickItem {
  stock: Stock;
  groupId: string;
}

interface StockSearchPick extends QuickPickItem {
  result?: StockSearchResult;
}

export interface CommandOptions {
  repository: WatchlistRepository;
  provider: MarketDataProvider;
  refresh(force: boolean, manual: boolean): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

async function chooseGroup(
  repository: WatchlistRepository,
  provided?: GroupNode,
): Promise<WatchGroup | undefined> {
  if (provided) {
    return provided.group;
  }
  const groups = repository.getSnapshot().groups;
  if (groups.length === 1) {
    return groups[0];
  }
  const picked = await window.showQuickPick<GroupPick>(
    groups.map((group) => ({
      label: group.name,
      description: `${group.stocks.length} 只`,
      group,
    })),
    { placeHolder: '选择分组' },
  );
  return picked?.group;
}

async function chooseStock(
  repository: WatchlistRepository,
  provided?: StockNode,
): Promise<StockPick | undefined> {
  if (provided) {
    return {
      label: provided.stock.name ?? provided.stock.symbol,
      stock: provided.stock,
      groupId: provided.groupId,
    };
  }
  const items = repository.getSnapshot().groups.flatMap((group) =>
    group.stocks.map((stock) => ({
      label: stock.name ?? stock.symbol,
      description: `${stock.symbol} · ${group.name}`,
      stock,
      groupId: group.id,
    })),
  );
  return window.showQuickPick<StockPick>(items, { placeHolder: '选择股票' });
}

function searchPickItems(results: readonly StockSearchResult[]): StockSearchPick[] {
  return results.map((result) => {
    const type = result.kind === 'index' ? '指数' : result.market === 'CN' ? 'A 股' : '港股';
    return {
      label: result.name,
      description: `${result.symbol} · ${type}`,
      ...(result.abbreviation
        ? { detail: `简称：${result.abbreviation.toUpperCase()}` }
        : {}),
      alwaysShow: true,
      result,
    };
  });
}

function chooseStockSearchResult(
  provider: MarketDataProvider,
  group: WatchGroup,
): Promise<StockSearchResult | undefined> {
  const picker = window.createQuickPick<StockSearchPick>();
  picker.title = `添加到“${group.name}”`;
  picker.placeholder = '输入名称、简称或代码，如 美的集团、mdjt、000333';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let generation = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (result: StockSearchResult | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      picker.hide();
    };

    const subscriptions: Disposable[] = [];
    subscriptions.push(
      picker.onDidChangeValue((value) => {
        generation += 1;
        const currentGeneration = generation;
        if (timer) {
          clearTimeout(timer);
        }
        request?.abort();
        request = undefined;

        const query = value.trim();
        if (!query) {
          picker.busy = false;
          picker.items = [];
          return;
        }

        picker.busy = true;
        timer = setTimeout(() => {
          const controller = new AbortController();
          request = controller;
          void provider
            .searchStocks(query, controller.signal)
            .then((results) => {
              if (controller.signal.aborted || currentGeneration !== generation) {
                return;
              }
              picker.items =
                results.length > 0
                  ? searchPickItems(results)
                  : [
                      {
                        label: '$(info) 未找到匹配的 A 股、港股或指数',
                        description: '请尝试完整名称、拼音简称或证券代码',
                        alwaysShow: true,
                      },
                    ];
            })
            .catch((error: unknown) => {
              if (controller.signal.aborted || currentGeneration !== generation) {
                return;
              }
              picker.items = [
                {
                  label: '$(warning) 搜索失败，请稍后重试',
                  description: messageOf(error),
                  alwaysShow: true,
                },
              ];
            })
            .finally(() => {
              if (currentGeneration === generation) {
                picker.busy = false;
              }
            });
        }, 250);
      }),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0] ?? picker.activeItems[0];
        if (selected?.result) {
          finish(selected.result);
        }
      }),
      picker.onDidHide(() => {
        if (timer) {
          clearTimeout(timer);
        }
        request?.abort();
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
        picker.dispose();
      }),
    );

    picker.show();
  });
}

export function registerCommands(options: CommandOptions): Disposable[] {
  const { repository, provider, refresh } = options;
  const afterChange = async (): Promise<void> => refresh(false, false);
  const handle = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error: unknown) {
      await window.showWarningMessage(`FishStock: ${messageOf(error)}`);
    }
  };

  return [
    commands.registerCommand('fishStock.addStock', async (node?: GroupNode) => {
      const group = await chooseGroup(repository, node);
      if (!group) {
        return;
      }
      const result = await chooseStockSearchResult(provider, group);
      if (!result) {
        return;
      }
      await handle(async () => {
        await repository.addStock(group.id, {
          id: randomUUID(),
          symbol: result.symbol,
          market: result.market,
          name: result.name,
        });
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.removeStock', async (node?: StockNode) => {
      const picked = await chooseStock(repository, node);
      if (!picked) {
        return;
      }
      const answer = await window.showWarningMessage(
        `从自选列表删除 ${picked.stock.name ?? picked.stock.symbol}？`,
        { modal: true },
        '删除',
      );
      if (answer !== '删除') {
        return;
      }
      await handle(async () => {
        await repository.removeStock(picked.stock.id);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.refresh', async () => {
      await refresh(true, true);
    }),

    commands.registerCommand('fishStock.addGroup', async () => {
      const name = await window.showInputBox({
        title: '添加分组',
        prompt: '分组名称',
        validateInput: (value) => (value.trim() ? undefined : '请输入分组名称'),
      });
      if (!name) {
        return;
      }
      await handle(async () => {
        await repository.addGroup(randomUUID(), name);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.renameGroup', async (node?: GroupNode) => {
      const group = await chooseGroup(repository, node);
      if (!group) {
        return;
      }
      const name = await window.showInputBox({
        title: '重命名分组',
        value: group.name,
        validateInput: (value) => (value.trim() ? undefined : '请输入分组名称'),
      });
      if (!name || name.trim() === group.name) {
        return;
      }
      await handle(async () => {
        await repository.renameGroup(group.id, name);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.removeGroup', async (node?: GroupNode) => {
      const group = await chooseGroup(repository, node);
      if (!group) {
        return;
      }
      const detail =
        group.stocks.length > 0
          ? `“${group.name}”中有 ${group.stocks.length} 只股票，删除分组会一并删除。`
          : `删除空分组“${group.name}”？`;
      const answer = await window.showWarningMessage(detail, { modal: true }, '删除分组');
      if (answer !== '删除分组') {
        return;
      }
      await handle(async () => {
        await repository.removeGroup(group.id);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.clearWatchlist', async () => {
      const state = repository.getSnapshot();
      const stockCount = state.groups.reduce(
        (total, group) => total + group.stocks.length,
        0,
      );
      const alreadyEmpty =
        state.groups.length === 1 &&
        state.groups[0].name === '默认' &&
        stockCount === 0;
      if (alreadyEmpty) {
        await window.showInformationMessage('FishStock: 自选数据已经是空的');
        return;
      }

      const answer = await window.showWarningMessage(
        '清空全部自选数据？',
        {
          modal: true,
          detail: `将删除 ${state.groups.length} 个分组和 ${stockCount} 只股票，并保留一个空的“默认”分组。此操作无法撤销。`,
        },
        '清空全部数据',
      );
      if (answer !== '清空全部数据') {
        return;
      }
      await handle(async () => {
        await repository.clear();
        await afterChange();
        window.setStatusBarMessage('FishStock: 自选数据已清空', 2_500);
      });
    }),

    commands.registerCommand('fishStock.restoreDefaultWatchlist', async () => {
      const state = repository.getSnapshot();
      const stockCount = state.groups.reduce(
        (total, group) => total + group.stocks.length,
        0,
      );
      const answer = await window.showWarningMessage(
        '恢复默认自选数据？',
        {
          modal: true,
          detail: `将用“默认”“指数”“银行”分组及 11 个默认条目替换当前 ${state.groups.length} 个分组及 ${stockCount} 只股票。此操作无法撤销。`,
        },
        '恢复默认数据',
      );
      if (answer !== '恢复默认数据') {
        return;
      }
      await handle(async () => {
        await repository.restoreDefault();
        await afterChange();
        window.setStatusBarMessage('FishStock: 已恢复默认自选数据', 2_500);
      });
    }),

    commands.registerCommand('fishStock.moveStockUp', async (node?: StockNode) => {
      const picked = await chooseStock(repository, node);
      if (!picked) {
        return;
      }
      await handle(async () => {
        await repository.moveStock(picked.stock.id, -1);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.moveStockDown', async (node?: StockNode) => {
      const picked = await chooseStock(repository, node);
      if (!picked) {
        return;
      }
      await handle(async () => {
        await repository.moveStock(picked.stock.id, 1);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.moveStockToGroup', async (node?: StockNode) => {
      const picked = await chooseStock(repository, node);
      if (!picked) {
        return;
      }
      const targets = repository
        .getSnapshot()
        .groups.filter((group) => group.id !== picked.groupId);
      if (targets.length === 0) {
        await window.showInformationMessage('FishStock: 请先创建另一个分组');
        return;
      }
      const target = await window.showQuickPick<GroupPick>(
        targets.map((group) => ({ label: group.name, group })),
        { placeHolder: '移动到分组' },
      );
      if (!target) {
        return;
      }
      await handle(async () => {
        await repository.moveStockToGroup(picked.stock.id, target.group.id);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.exportJson', async () => {
      const uri = await window.showSaveDialog({
        title: '导出 FishStock 自选股',
        saveLabel: '导出',
        filters: { JSON: ['json'] },
      });
      if (!uri) {
        return;
      }
      await handle(async () => {
        const data = JSON.stringify(repository.getSnapshot(), null, 2);
        await workspace.fs.writeFile(uri, new TextEncoder().encode(`${data}\n`));
        await window.showInformationMessage('FishStock: 自选股已导出');
      });
    }),

    commands.registerCommand('fishStock.importJson', async () => {
      const selected = await window.showOpenDialog({
        title: '导入 FishStock 自选股',
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      const uri = selected?.[0];
      if (!uri) {
        return;
      }
      await handle(async () => {
        const bytes = await workspace.fs.readFile(uri);
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const state = parseWatchlistState(parsed);
        const stockCount = state.groups.reduce((total, group) => total + group.stocks.length, 0);
        const answer = await window.showWarningMessage(
          `将用 ${state.groups.length} 个分组、${stockCount} 只股票替换当前自选列表。`,
          { modal: true },
          '导入并替换',
        );
        if (answer !== '导入并替换') {
          return;
        }
        await repository.replace(state);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.openWatchlist', async () => {
      await commands.executeCommand('workbench.view.extension.fishStock');
      await commands.executeCommand('fishStock.stock.focus');
    }),
  ];
}
