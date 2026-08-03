import type { StockSearchResult } from '../domain/models';
import type { ViewKind } from '../storage/viewOptionsStore';

export interface CommandNames {
  add: string;
  remove: string;
  refresh: string;
  addGroup: string;
  renameGroup: string;
  removeGroup: string;
  moveUp: string;
  moveDown: string;
  moveToGroup: string;
  open: string;
  clear: string;
  restoreDefault: string;
  viewMode: string;
  expandAll: string;
  focusView: string;
}

export interface SearchResultDescription {
  description: string;
  detail?: string;
}

export interface CommandTexts {
  groupPickPlaceholder: string;
  groupCountSuffix: string;
  itemPickPlaceholder: string;
  searchPlaceholder: string;
  searchEmptyLabel: string;
  searchEmptyHint: string;
  describeSearchResult(result: StockSearchResult): SearchResultDescription;
  removeConfirm(name: string): string;
  addGroupTitle: string;
  renameGroupTitle: string;
  removeGroupDetail(name: string, count: number): string;
  moveToGroupHint: string;
  moveToGroupPlaceholder: string;
  clearTitle: string;
  clearDetail(groupCount: number, itemCount: number): string;
  clearButton: string;
  clearMessage: string;
  alreadyEmptyMessage: string;
  restoreTitle: string;
  restoreDetail(groupCount: number, itemCount: number): string;
  restoreButton: string;
  restoreMessage: string;
}

export interface WatchlistCommandSet {
  names: CommandNames;
  texts: CommandTexts;
  viewKind: ViewKind;
}

export function buildStockCommandSet(): WatchlistCommandSet {
  return {
    names: {
      add: 'fishStock.addStock',
      remove: 'fishStock.removeStock',
      refresh: 'fishStock.refresh',
      addGroup: 'fishStock.addGroup',
      renameGroup: 'fishStock.renameGroup',
      removeGroup: 'fishStock.removeGroup',
      moveUp: 'fishStock.moveStockUp',
      moveDown: 'fishStock.moveStockDown',
      moveToGroup: 'fishStock.moveStockToGroup',
      open: 'fishStock.openWatchlist',
      clear: 'fishStock.clearWatchlist',
      restoreDefault: 'fishStock.restoreDefaultWatchlist',
      viewMode: 'fishStock.stockViewMode',
      expandAll: 'fishStock.expandAllStockGroups',
      focusView: 'fishStock.stock.focus',
    },
    texts: {
      groupPickPlaceholder: '选择分组',
      groupCountSuffix: '只',
      itemPickPlaceholder: '选择股票',
      searchPlaceholder: '输入名称、简称或代码，如 美的集团、mdjt、000333',
      searchEmptyLabel: '$(info) 未找到匹配的 A 股、港股或指数',
      searchEmptyHint: '请尝试完整名称、拼音简称或证券代码',
      describeSearchResult: (result) => ({
        description: `${result.symbol} · ${
          result.kind === 'index' ? '指数' : result.market === 'CN' ? 'A 股' : '港股'
        }`,
        ...(result.abbreviation
          ? { detail: `简称：${result.abbreviation.toUpperCase()}` }
          : {}),
      }),
      removeConfirm: (name) => `从自选列表删除 ${name}？`,
      addGroupTitle: '添加分组',
      renameGroupTitle: '重命名分组',
      removeGroupDetail: (name, count) =>
        count > 0
          ? `“${name}”中有 ${count} 只股票，删除分组会一并删除。`
          : `删除空分组“${name}”？`,
      moveToGroupHint: '请先创建另一个分组',
      moveToGroupPlaceholder: '移动到分组',
      clearTitle: '清空全部股票自选数据？',
      clearDetail: (groupCount, itemCount) =>
        `将删除 ${groupCount} 个分组和 ${itemCount} 只股票，并保留一个空的“默认”分组。此操作无法撤销。`,
      clearButton: '清空全部数据',
      clearMessage: 'FishStock: 股票自选数据已清空',
      alreadyEmptyMessage: 'FishStock: 股票自选数据已经是空的',
      restoreTitle: '恢复默认股票自选数据？',
      restoreDetail: (groupCount, itemCount) =>
        `将用“默认”“指数”“银行”分组及 11 个默认条目替换当前 ${groupCount} 个分组及 ${itemCount} 只股票。此操作无法撤销。`,
      restoreButton: '恢复默认数据',
      restoreMessage: 'FishStock: 已恢复默认股票自选数据',
    },
    viewKind: 'stock',
  };
}

export function buildFuturesCommandSet(): WatchlistCommandSet {
  return {
    names: {
      add: 'fishStock.addFuture',
      remove: 'fishStock.removeFuture',
      refresh: 'fishStock.refreshFutures',
      addGroup: 'fishStock.addFuturesGroup',
      renameGroup: 'fishStock.renameFuturesGroup',
      removeGroup: 'fishStock.removeFuturesGroup',
      moveUp: 'fishStock.moveFutureUp',
      moveDown: 'fishStock.moveFutureDown',
      moveToGroup: 'fishStock.moveFutureToGroup',
      open: 'fishStock.openFutures',
      clear: 'fishStock.clearFuturesWatchlist',
      restoreDefault: 'fishStock.restoreDefaultFuturesWatchlist',
      viewMode: 'fishStock.futuresViewMode',
      expandAll: 'fishStock.expandAllFuturesGroups',
      focusView: 'fishStock.futures.focus',
    },
    texts: {
      groupPickPlaceholder: '选择期货分组',
      groupCountSuffix: '个',
      itemPickPlaceholder: '选择期货合约',
      searchPlaceholder: '输入品种或合约代码，如 电解铝主连、沪金、AL2608',
      searchEmptyLabel: '$(info) 未找到匹配的国内期货',
      searchEmptyHint: '请尝试品种名称、主连代码或月份合约代码',
      describeSearchResult: (result) => ({
        description: `${result.symbol} · ${result.symbol.endsWith('0.CNF') ? '主连' : '月份合约'}`,
        ...(result.venue ? { detail: result.venue } : {}),
      }),
      removeConfirm: (name) => `从期货自选删除 ${name}？`,
      addGroupTitle: '添加期货分组',
      renameGroupTitle: '重命名期货分组',
      removeGroupDetail: (name, count) =>
        count > 0
          ? `“${name}”中有 ${count} 个期货条目，删除分组会一并删除。`
          : `删除空分组“${name}”？`,
      moveToGroupHint: '请先创建另一个期货分组',
      moveToGroupPlaceholder: '移动到期货分组',
      clearTitle: '清空全部期货自选？',
      clearDetail: (groupCount, itemCount) =>
        `将删除 ${groupCount} 个分组和 ${itemCount} 个期货条目，并保留一个空的“默认”分组。此操作无法撤销。`,
      clearButton: '清空期货自选',
      clearMessage: 'FishStock: 期货自选已清空',
      alreadyEmptyMessage: 'FishStock: 期货自选已经是空的',
      restoreTitle: '恢复默认期货自选数据？',
      restoreDetail: (groupCount, itemCount) =>
        `将用“默认”分组及 5 个默认主连合约替换当前 ${groupCount} 个分组及 ${itemCount} 个期货条目。此操作无法撤销。`,
      restoreButton: '恢复默认数据',
      restoreMessage: 'FishStock: 已恢复默认期货自选数据',
    },
    viewKind: 'futures',
  };
}
