import { randomUUID } from 'node:crypto';
import {
  commands,
  window,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { FuturesDataProvider } from '../data/marketDataProvider';
import type { Stock, StockSearchResult, WatchGroup } from '../domain/models';
import type { WatchlistRepository } from '../storage/watchlistRepository';
import type { GroupNode, StockNode } from '../ui/watchlistTreeProvider';

interface GroupPick extends QuickPickItem {
  group: WatchGroup;
}

interface FuturePick extends QuickPickItem {
  future: Stock;
  groupId: string;
}

interface FutureSearchPick extends QuickPickItem {
  result?: StockSearchResult;
}

export interface FuturesCommandOptions {
  repository: WatchlistRepository;
  provider: FuturesDataProvider;
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
      description: `${group.stocks.length} 个`,
      group,
    })),
    { placeHolder: '选择期货分组' },
  );
  return picked?.group;
}

async function chooseFuture(
  repository: WatchlistRepository,
  provided?: StockNode,
): Promise<FuturePick | undefined> {
  if (provided) {
    return {
      label: provided.stock.name ?? provided.stock.symbol,
      future: provided.stock,
      groupId: provided.groupId,
    };
  }
  const items = repository.getSnapshot().groups.flatMap((group) =>
    group.stocks.map((future) => ({
      label: future.name ?? future.symbol,
      description: `${future.symbol} · ${group.name}`,
      future,
      groupId: group.id,
    })),
  );
  return window.showQuickPick<FuturePick>(items, { placeHolder: '选择期货合约' });
}

function searchPickItems(results: readonly StockSearchResult[]): FutureSearchPick[] {
  return results.map((result) => ({
    label: result.name,
    description: `${result.symbol} · ${result.symbol.endsWith('0.CNF') ? '主连' : '月份合约'}`,
    ...(result.venue ? { detail: result.venue } : {}),
    alwaysShow: true,
    result,
  }));
}

function chooseFutureSearchResult(
  provider: FuturesDataProvider,
  group: WatchGroup,
): Promise<StockSearchResult | undefined> {
  const picker = window.createQuickPick<FutureSearchPick>();
  picker.title = `添加到“${group.name}”`;
  picker.placeholder = '输入品种或合约代码，如 电解铝主连、沪金、AL2608';
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
            .searchFutures(query, controller.signal)
            .then((results) => {
              if (controller.signal.aborted || currentGeneration !== generation) {
                return;
              }
              picker.items =
                results.length > 0
                  ? searchPickItems(results)
                  : [
                      {
                        label: '$(info) 未找到匹配的国内期货',
                        description: '请尝试品种名称、主连代码或月份合约代码',
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

export function registerFuturesCommands(options: FuturesCommandOptions): Disposable[] {
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
    commands.registerCommand('fishStock.addFuture', async (node?: GroupNode) => {
      const group = await chooseGroup(repository, node);
      if (!group) {
        return;
      }
      const result = await chooseFutureSearchResult(provider, group);
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

    commands.registerCommand('fishStock.removeFuture', async (node?: StockNode) => {
      const picked = await chooseFuture(repository, node);
      if (!picked) {
        return;
      }
      const answer = await window.showWarningMessage(
        `从期货自选删除 ${picked.future.name ?? picked.future.symbol}？`,
        { modal: true },
        '删除',
      );
      if (answer !== '删除') {
        return;
      }
      await handle(async () => {
        await repository.removeStock(picked.future.id);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.refreshFutures', async () => {
      await refresh(true, true);
    }),

    commands.registerCommand('fishStock.addFuturesGroup', async () => {
      const name = await window.showInputBox({
        title: '添加期货分组',
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

    commands.registerCommand('fishStock.renameFuturesGroup', async (node?: GroupNode) => {
      const group = await chooseGroup(repository, node);
      if (!group) {
        return;
      }
      const name = await window.showInputBox({
        title: '重命名期货分组',
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

    commands.registerCommand('fishStock.removeFuturesGroup', async (node?: GroupNode) => {
      const group = await chooseGroup(repository, node);
      if (!group) {
        return;
      }
      const detail =
        group.stocks.length > 0
          ? `“${group.name}”中有 ${group.stocks.length} 个期货条目，删除分组会一并删除。`
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

    commands.registerCommand('fishStock.moveFutureUp', async (node?: StockNode) => {
      const picked = await chooseFuture(repository, node);
      if (!picked) {
        return;
      }
      await handle(async () => {
        await repository.moveStock(picked.future.id, -1);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.moveFutureDown', async (node?: StockNode) => {
      const picked = await chooseFuture(repository, node);
      if (!picked) {
        return;
      }
      await handle(async () => {
        await repository.moveStock(picked.future.id, 1);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.moveFutureToGroup', async (node?: StockNode) => {
      const picked = await chooseFuture(repository, node);
      if (!picked) {
        return;
      }
      const targets = repository
        .getSnapshot()
        .groups.filter((group) => group.id !== picked.groupId);
      if (targets.length === 0) {
        await window.showInformationMessage('FishStock: 请先创建另一个期货分组');
        return;
      }
      const target = await window.showQuickPick<GroupPick>(
        targets.map((group) => ({ label: group.name, group })),
        { placeHolder: '移动到期货分组' },
      );
      if (!target) {
        return;
      }
      await handle(async () => {
        await repository.moveStockToGroup(picked.future.id, target.group.id);
        await afterChange();
      });
    }),

    commands.registerCommand('fishStock.clearFuturesWatchlist', async () => {
      const state = repository.getSnapshot();
      const futureCount = state.groups.reduce(
        (total, group) => total + group.stocks.length,
        0,
      );
      if (state.groups.length === 1 && state.groups[0].name === '默认' && futureCount === 0) {
        await window.showInformationMessage('FishStock: 期货自选已经是空的');
        return;
      }
      const answer = await window.showWarningMessage(
        '清空全部期货自选？',
        {
          modal: true,
          detail: `将删除 ${state.groups.length} 个分组和 ${futureCount} 个期货条目，并保留一个空的“默认”分组。此操作无法撤销。`,
        },
        '清空期货自选',
      );
      if (answer !== '清空期货自选') {
        return;
      }
      await handle(async () => {
        await repository.clear();
        await afterChange();
        window.setStatusBarMessage('FishStock: 期货自选已清空', 2_500);
      });
    }),

    commands.registerCommand('fishStock.restoreDefaultFuturesWatchlist', async () => {
      const state = repository.getSnapshot();
      const futureCount = state.groups.reduce(
        (total, group) => total + group.stocks.length,
        0,
      );
      const answer = await window.showWarningMessage(
        '恢复默认期货自选数据？',
        {
          modal: true,
          detail: `将用“默认”分组及 5 个默认主连合约替换当前 ${state.groups.length} 个分组及 ${futureCount} 个期货条目。此操作无法撤销。`,
        },
        '恢复默认数据',
      );
      if (answer !== '恢复默认数据') {
        return;
      }
      await handle(async () => {
        await repository.restoreDefault();
        await afterChange();
        window.setStatusBarMessage('FishStock: 已恢复默认期货自选数据', 2_500);
      });
    }),

    commands.registerCommand('fishStock.openFutures', async () => {
      await commands.executeCommand('workbench.view.extension.fishStock');
      await commands.executeCommand('fishStock.futures.focus');
    }),
  ];
}
