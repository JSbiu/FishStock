import { randomUUID } from 'node:crypto';
import {
  commands,
  env,
  Uri,
  window,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { Stock, StockSearchResult, WatchGroup } from '../domain/models';
import { buildQuoteUrl } from '../domain/quoteUrl';
import type { ViewMode } from '../domain/viewOptions';
import type { ViewOptionsStore } from '../storage/viewOptionsStore';
import type { WatchlistRepository } from '../storage/watchlistRepository';
import type { GroupNode, StockNode, WatchlistTreeProvider } from '../ui/watchlistTreeProvider';
import type { WatchlistCommandSet } from './commandSets';

export interface WatchlistCommandOptions {
  repository: WatchlistRepository;
  search(query: string, signal?: AbortSignal): Promise<StockSearchResult[]>;
  refresh(force: boolean, manual: boolean): Promise<void>;
  viewOptions: ViewOptionsStore;
  treeProvider: WatchlistTreeProvider;
  set: WatchlistCommandSet;
  registerCommonCommands?: boolean;
}

interface GroupPick extends QuickPickItem {
  group: WatchGroup;
}

interface ItemPick extends QuickPickItem {
  stock: Stock;
  groupId: string;
}

interface SearchPick extends QuickPickItem {
  result?: StockSearchResult;
}

const VIEW_MODE_PICKS: ReadonlyArray<{ label: string; description: string; mode: ViewMode }> = [
  { label: '默认顺序', description: '按添加顺序', mode: 'default' },
  { label: '涨幅从高到低', description: '按涨跌幅降序', mode: 'gainDesc' },
  { label: '涨幅从低到高', description: '按涨跌幅升序', mode: 'lossDesc' },
  { label: '仅看上涨', description: '隐藏下跌条目', mode: 'upOnly' },
  { label: '仅看下跌', description: '隐藏上涨条目', mode: 'downOnly' },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

async function chooseGroup(
  repository: WatchlistRepository,
  set: WatchlistCommandSet,
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
      description: `${group.stocks.length} ${set.texts.groupCountSuffix}`,
      group,
    })),
    { placeHolder: set.texts.groupPickPlaceholder },
  );
  return picked?.group;
}

async function chooseItem(
  repository: WatchlistRepository,
  set: WatchlistCommandSet,
  provided?: StockNode,
): Promise<ItemPick | undefined> {
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
  return window.showQuickPick<ItemPick>(items, { placeHolder: set.texts.itemPickPlaceholder });
}

function searchPickItems(
  results: readonly StockSearchResult[],
  set: WatchlistCommandSet,
): SearchPick[] {
  return results.map((result) => ({
    label: result.name,
    ...set.texts.describeSearchResult(result),
    alwaysShow: true,
    result,
  }));
}

function chooseSearchResult(
  search: (query: string, signal?: AbortSignal) => Promise<StockSearchResult[]>,
  group: WatchGroup,
  set: WatchlistCommandSet,
): Promise<StockSearchResult | undefined> {
  const picker = window.createQuickPick<SearchPick>();
  picker.title = `添加到“${group.name}”`;
  picker.placeholder = set.texts.searchPlaceholder;
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
          void search(query, controller.signal)
            .then((results) => {
              if (controller.signal.aborted || currentGeneration !== generation) {
                return;
              }
              picker.items =
                results.length > 0
                  ? searchPickItems(results, set)
                  : [
                      {
                        label: set.texts.searchEmptyLabel,
                        description: set.texts.searchEmptyHint,
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

async function chooseViewMode(current: ViewMode): Promise<ViewMode | undefined> {
  const picked = await window.showQuickPick(
    VIEW_MODE_PICKS.map((pick) => ({
      label: pick.label,
      description: `${pick.description}${pick.mode === current ? '（当前）' : ''}`,
      mode: pick.mode,
    })),
    { placeHolder: '选择视图展示方式' },
  );
  return picked?.mode;
}

export function registerWatchlistCommands(
  options: WatchlistCommandOptions,
): Disposable[] {
  const { repository, search, refresh, viewOptions, treeProvider, set } = options;
  const { names, texts } = set;
  const afterChange = async (): Promise<void> => refresh(false, false);
  const handle = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error: unknown) {
      await window.showWarningMessage(`FishStock: ${messageOf(error)}`);
    }
  };

  const disposables: Disposable[] = [
    commands.registerCommand(names.add, async (node?: GroupNode) => {
      const group = await chooseGroup(repository, set, node);
      if (!group) {
        return;
      }
      const result = await chooseSearchResult(search, group, set);
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

    commands.registerCommand(names.remove, async (node?: StockNode) => {
      const picked = await chooseItem(repository, set, node);
      if (!picked) {
        return;
      }
      const answer = await window.showWarningMessage(
        texts.removeConfirm(picked.stock.name ?? picked.stock.symbol),
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

    commands.registerCommand(names.refresh, async () => {
      await refresh(true, true);
    }),

    commands.registerCommand(names.addGroup, async () => {
      const name = await window.showInputBox({
        title: texts.addGroupTitle,
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

    commands.registerCommand(names.renameGroup, async (node?: GroupNode) => {
      const group = await chooseGroup(repository, set, node);
      if (!group) {
        return;
      }
      const name = await window.showInputBox({
        title: texts.renameGroupTitle,
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

    commands.registerCommand(names.removeGroup, async (node?: GroupNode) => {
      const group = await chooseGroup(repository, set, node);
      if (!group) {
        return;
      }
      const answer = await window.showWarningMessage(
        texts.removeGroupDetail(group.name, group.stocks.length),
        { modal: true },
        '删除分组',
      );
      if (answer !== '删除分组') {
        return;
      }
      await handle(async () => {
        await repository.removeGroup(group.id);
        await afterChange();
      });
    }),

    commands.registerCommand(names.moveUp, async (node?: StockNode) => {
      const picked = await chooseItem(repository, set, node);
      if (!picked) {
        return;
      }
      await handle(async () => {
        await repository.moveStock(picked.stock.id, -1);
        await afterChange();
      });
    }),

    commands.registerCommand(names.moveDown, async (node?: StockNode) => {
      const picked = await chooseItem(repository, set, node);
      if (!picked) {
        return;
      }
      await handle(async () => {
        await repository.moveStock(picked.stock.id, 1);
        await afterChange();
      });
    }),

    commands.registerCommand(names.moveToGroup, async (node?: StockNode) => {
      const picked = await chooseItem(repository, set, node);
      if (!picked) {
        return;
      }
      const targets = repository
        .getSnapshot()
        .groups.filter((group) => group.id !== picked.groupId);
      if (targets.length === 0) {
        await window.showInformationMessage(`FishStock: ${texts.moveToGroupHint}`);
        return;
      }
      const target = await window.showQuickPick<GroupPick>(
        targets.map((group) => ({ label: group.name, group })),
        { placeHolder: texts.moveToGroupPlaceholder },
      );
      if (!target) {
        return;
      }
      await handle(async () => {
        await repository.moveStockToGroup(picked.stock.id, target.group.id);
        await afterChange();
      });
    }),

    commands.registerCommand(names.open, async () => {
      await commands.executeCommand('workbench.view.extension.fishStock');
      await commands.executeCommand(names.focusView);
    }),

    commands.registerCommand(names.clear, async () => {
      const state = repository.getSnapshot();
      const itemCount = state.groups.reduce(
        (total, group) => total + group.stocks.length,
        0,
      );
      const alreadyEmpty =
        state.groups.length === 1 &&
        state.groups[0].name === '默认' &&
        itemCount === 0;
      if (alreadyEmpty) {
        await window.showInformationMessage(texts.alreadyEmptyMessage);
        return;
      }

      const answer = await window.showWarningMessage(
        texts.clearTitle,
        {
          modal: true,
          detail: texts.clearDetail(state.groups.length, itemCount),
        },
        texts.clearButton,
      );
      if (answer !== texts.clearButton) {
        return;
      }
      await handle(async () => {
        await repository.clear();
        await afterChange();
        window.setStatusBarMessage(texts.clearMessage, 2_500);
      });
    }),

    commands.registerCommand(names.restoreDefault, async () => {
      const state = repository.getSnapshot();
      const itemCount = state.groups.reduce(
        (total, group) => total + group.stocks.length,
        0,
      );
      const answer = await window.showWarningMessage(
        texts.restoreTitle,
        {
          modal: true,
          detail: texts.restoreDetail(state.groups.length, itemCount),
        },
        texts.restoreButton,
      );
      if (answer !== texts.restoreButton) {
        return;
      }
      await handle(async () => {
        await repository.restoreDefault();
        await afterChange();
        window.setStatusBarMessage(texts.restoreMessage, 2_500);
      });
    }),

    commands.registerCommand(names.viewMode, async () => {
      const current = viewOptions.getSnapshot()[set.viewKind];
      const mode = await chooseViewMode(current);
      if (!mode || mode === current) {
        return;
      }
      await handle(async () => {
        await viewOptions.setViewMode(set.viewKind, mode);
        treeProvider.setViewMode(mode);
      });
    }),
  ];

  if (options.registerCommonCommands) {
    disposables.push(
      commands.registerCommand('fishStock.openQuote', async (node?: StockNode) => {
        if (!node) {
          await window.showInformationMessage('FishStock: 请点击自选条目打开行情页面');
          return;
        }
        const url = buildQuoteUrl(node.stock.symbol);
        if (!url) {
          await window.showInformationMessage(
            `FishStock: ${node.stock.symbol} 暂不支持行情页跳转`,
          );
          return;
        }
        await env.openExternal(Uri.parse(url));
      }),
    );
  }

  return disposables;
}
