import { type FileDecorationProvider, type Uri } from 'vscode';

/**
 * 自选条目若在持仓里，TreeProvider 会给它挂上 `fishstock-holding:<symbol>` 形式的
 * resourceUri。因此这里只认 scheme，不再查一遍持仓集合——"带这个 scheme"本身就是
 * TreeProvider 给出的标记契约，重复判定只会让两处状态需要同步。
 * 该 provider 只识别这个 scheme，不会污染其他 View 的 TreeItem。
 */
export const HOLDING_DECORATION_SCHEME = 'fishstock-holding';

/**
 * 只挂角标、不染色：TreeItem 的文字颜色只能整条目设置（FileDecoration 的 color），
 * 而一个条目只有一个颜色值——用它标记持仓，就没有通道再表达涨跌方向了。
 * 角标是图标右上角的小徽标（VS Code 固定位置，无法移到行尾），比整行染色克制得多。
 */
const HOLDING_BADGE = '持';
const HOLDING_TOOLTIP = '已在持仓';

export class HoldingFileDecorationProvider implements FileDecorationProvider {
  public provideFileDecoration(uri: Uri): { badge?: string; tooltip?: string } | undefined {
    return uri.scheme === HOLDING_DECORATION_SCHEME
      ? { badge: HOLDING_BADGE, tooltip: HOLDING_TOOLTIP }
      : undefined;
  }
}
