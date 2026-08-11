import type { Disposable } from 'vscode';

interface PrewarmTreeView<T> {
  readonly visible: boolean;
  onDidChangeVisibility(listener: (event: { visible: boolean }) => unknown): Disposable;
  reveal(
    element: T,
    options: { expand?: boolean | number; focus?: boolean; select?: boolean },
  ): Thenable<void>;
}

export interface TreeViewPrewarmEntry<T> {
  label: string;
  treeView: PrewarmTreeView<T>;
  element: T;
}

interface TreeViewPrewarmOptions {
  restorePreviousSidebar(): Thenable<unknown>;
  onError(label: string, error: unknown): void;
  visibilityTimeoutMs?: number;
  settleDelayMs?: number;
}

export function prewarmTreeViews<T>(
  entries: readonly TreeViewPrewarmEntry<T>[],
  options: TreeViewPrewarmOptions,
): Disposable {
  const fishStockWasVisible = entries.some((entry) => entry.treeView.visible);
  const visibleLabels = new Set(
    entries.filter((entry) => entry.treeView.visible).map((entry) => entry.label),
  );
  const registrations: Disposable[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let completed = false;

  const cleanup = (): void => {
    for (const registration of registrations.splice(0)) {
      registration.dispose();
    }
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
  };

  const complete = (): void => {
    if (disposed || completed) {
      return;
    }
    completed = true;
    cleanup();
    const restore = !fishStockWasVisible
      ? options.restorePreviousSidebar()
      : Promise.resolve();
    void Promise.resolve(restore)
      .catch((error: unknown) => options.onError('侧边栏恢复', error));
  };

  const scheduleComplete = (): void => {
    if (completed || settleTimer) {
      return;
    }
    settleTimer = setTimeout(complete, options.settleDelayMs ?? 50);
  };

  for (const entry of entries) {
    registrations.push(
      entry.treeView.onDidChangeVisibility((event) => {
        if (!event.visible) {
          return;
        }
        visibleLabels.add(entry.label);
        if (visibleLabels.size === entries.length) {
          scheduleComplete();
        }
      }),
    );
  }

  timeoutTimer = setTimeout(scheduleComplete, options.visibilityTimeoutMs ?? 750);
  for (const entry of entries) {
    void Promise.resolve(
      entry.treeView.reveal(entry.element, { expand: false, focus: false, select: false }),
    ).catch((error: unknown) => options.onError(entry.label, error));
  }
  if (visibleLabels.size === entries.length) {
    scheduleComplete();
  }

  return {
    dispose: () => {
      disposed = true;
      cleanup();
    },
  };
}
