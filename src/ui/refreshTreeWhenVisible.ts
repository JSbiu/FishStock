import type { Disposable } from 'vscode';

interface TreeVisibilitySource {
  onDidChangeVisibility(listener: (event: { visible: boolean }) => unknown): Disposable;
}

interface RefreshableTree {
  refresh(): void;
}

export function refreshTreeWhenVisible(
  treeView: TreeVisibilitySource,
  provider: RefreshableTree,
): Disposable {
  provider.refresh();
  return treeView.onDidChangeVisibility((event) => {
    if (event.visible) {
      provider.refresh();
    }
  });
}
