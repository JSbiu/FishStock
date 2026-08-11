import assert from 'node:assert/strict';
import test from 'node:test';
import type { Disposable } from 'vscode';
import { prewarmTreeViews } from '../ui/prewarmTreeViews';

class FakeTreeView {
  private readonly listeners = new Set<(event: { visible: boolean }) => unknown>();
  public revealCount = 0;

  public constructor(public visible: boolean) {}

  public onDidChangeVisibility(
    listener: (event: { visible: boolean }) => unknown,
  ): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async reveal(): Promise<void> {
    this.revealCount += 1;
    this.visible = true;
    for (const listener of this.listeners) {
      listener({ visible: true });
    }
  }
}

function nextTimer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('prewarms every tree and restores the previous sidebar when FishStock was hidden', async () => {
  const stock = new FakeTreeView(false);
  const fund = new FakeTreeView(false);
  const futures = new FakeTreeView(false);
  let restored = 0;

  const registration = prewarmTreeViews(
    [
      { label: 'Stock', treeView: stock, element: 'stock' },
      { label: 'Fund', treeView: fund, element: 'fund' },
      { label: 'Futures', treeView: futures, element: 'futures' },
    ],
    {
      restorePreviousSidebar: async () => {
        restored += 1;
      },
      onError: (_label, error) => assert.fail(String(error)),
      settleDelayMs: 0,
    },
  );

  await nextTimer();
  assert.equal(stock.revealCount, 1);
  assert.equal(fund.revealCount, 1);
  assert.equal(futures.revealCount, 1);
  assert.equal(restored, 1);
  registration.dispose();
});

test('does not leave FishStock when one of its trees was already visible', async () => {
  const stock = new FakeTreeView(true);
  const fund = new FakeTreeView(false);
  let restored = 0;

  const registration = prewarmTreeViews(
    [
      { label: 'Stock', treeView: stock, element: 'stock' },
      { label: 'Fund', treeView: fund, element: 'fund' },
    ],
    {
      restorePreviousSidebar: async () => {
        restored += 1;
      },
      onError: (_label, error) => assert.fail(String(error)),
      settleDelayMs: 0,
    },
  );

  await nextTimer();
  assert.equal(stock.revealCount, 1);
  assert.equal(fund.revealCount, 1);
  assert.equal(restored, 0);
  registration.dispose();
});
