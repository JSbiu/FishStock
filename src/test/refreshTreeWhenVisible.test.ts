import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshTreeWhenVisible } from '../ui/refreshTreeWhenVisible';

test('uses the first visible render to consume data refreshed while never shown', () => {
  let listener: ((event: { visible: boolean }) => unknown) | undefined;
  let refreshes = 0;
  let disposed = false;
  const treeView = {
    visible: false,
    onDidChangeVisibility: (value: (event: { visible: boolean }) => unknown) => {
      listener = value;
      return {
        dispose: () => {
          disposed = true;
        },
      };
    },
  };
  const registration = refreshTreeWhenVisible(
    treeView,
    {
      refresh: () => {
        refreshes += 1;
      },
    },
  );

  registration.requestRefresh();
  assert.equal(refreshes, 0);
  listener?.({ visible: false });
  assert.equal(refreshes, 0);
  treeView.visible = true;
  listener?.({ visible: true });
  assert.equal(refreshes, 0);

  registration.dispose();
  assert.equal(disposed, true);
});

test('refreshes immediately while visible and defers later hidden changes', async () => {
  let listener: ((event: { visible: boolean }) => unknown) | undefined;
  let refreshes = 0;
  const treeView = {
    visible: true,
    onDidChangeVisibility: (value: (event: { visible: boolean }) => unknown) => {
      listener = value;
      return { dispose: () => undefined };
    },
  };
  const registration = refreshTreeWhenVisible(treeView, {
    refresh: () => {
      refreshes += 1;
    },
  });

  registration.requestRefresh();
  assert.equal(refreshes, 1);

  treeView.visible = false;
  listener?.({ visible: false });
  registration.requestRefresh();
  registration.requestRefresh();
  assert.equal(refreshes, 1);

  treeView.visible = true;
  listener?.({ visible: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 2);

  registration.dispose();
});
