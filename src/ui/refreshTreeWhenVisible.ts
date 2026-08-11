import type { Disposable } from 'vscode';

interface TreeVisibilitySource {
  readonly visible: boolean;
  onDidChangeVisibility(listener: (event: { visible: boolean }) => unknown): Disposable;
}

interface RefreshableTree {
  refresh(): void;
}

export interface VisibleTreeRefreshController extends Disposable {
  requestRefresh(): void;
}

export function refreshTreeWhenVisible(
  treeView: TreeVisibilitySource,
  provider: RefreshableTree,
): VisibleTreeRefreshController {
  let hasBeenVisible = treeView.visible;
  let refreshPending = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const schedulePendingRefresh = (): void => {
    if (refreshTimer) {
      return;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (disposed || !treeView.visible || !refreshPending) {
        return;
      }
      refreshPending = false;
      provider.refresh();
    }, 0);
  };

  const visibilityRegistration = treeView.onDidChangeVisibility((event) => {
    if (!event.visible) {
      return;
    }
    if (!hasBeenVisible) {
      hasBeenVisible = true;
      refreshPending = false;
      return;
    }
    if (refreshPending) {
      schedulePendingRefresh();
    }
  });

  return {
    requestRefresh: () => {
      if (treeView.visible) {
        refreshPending = false;
        provider.refresh();
        return;
      }
      refreshPending = true;
    },
    dispose: () => {
      disposed = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      visibilityRegistration.dispose();
    },
  };
}
