import { randomUUID } from 'node:crypto';
import {
  commands,
  window,
  workspace,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { MarketDataProvider } from '../data/marketDataProvider';
import type { Stock, WatchGroup } from '../domain/models';
import { normalizeSymbol } from '../domain/symbol';
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

export interface CommandOptions {
  repository: WatchlistRepository;
  provider: MarketDataProvider;
  refresh(force: boolean, manual: boolean): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function splitStockInput(value: string): { code: string; name?: string } {
  const [code, ...nameParts] = value.trim().split(/\s+/);
  const name = nameParts.join(' ').trim();
  return { code, ...(name ? { name } : {}) };
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
    commands.registerCommand('fishStock.addStock', async () => {
      const group = await chooseGroup(repository);
      if (!group) {
        return;
      }
      const input = await window.showInputBox({
        title: `添加到“${group.name}”`,
        prompt: '输入股票代码；可在代码后空格填写显示名称',
        placeHolder: '600519 或 00700.HK 腾讯控股',
        validateInput: (value) => {
          try {
            const normalized = normalizeSymbol(splitStockInput(value).code);
            return provider.supports(normalized.market) ? undefined : 'v0.1 暂只支持 A 股和港股';
          } catch (error: unknown) {
            return messageOf(error);
          }
        },
      });
      if (!input) {
        return;
      }
      await handle(async () => {
        const parsed = splitStockInput(input);
        const normalized = normalizeSymbol(parsed.code);
        await repository.addStock(group.id, {
          id: randomUUID(),
          symbol: normalized.symbol,
          market: normalized.market,
          ...(parsed.name ? { name: parsed.name } : {}),
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
      await commands.executeCommand('fishStock.watchlist.focus');
    }),
  ];
}
