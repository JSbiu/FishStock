import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshTreeWhenVisible } from '../ui/refreshTreeWhenVisible';

test('refreshes local tree data immediately and whenever the view becomes visible', () => {
  let listener: ((event: { visible: boolean }) => unknown) | undefined;
  let refreshes = 0;
  let disposed = false;
  const registration = refreshTreeWhenVisible(
    {
      onDidChangeVisibility: (value) => {
        listener = value;
        return {
          dispose: () => {
            disposed = true;
          },
        };
      },
    },
    {
      refresh: () => {
        refreshes += 1;
      },
    },
  );

  assert.equal(refreshes, 1);
  listener?.({ visible: false });
  assert.equal(refreshes, 1);
  listener?.({ visible: true });
  assert.equal(refreshes, 2);

  registration.dispose();
  assert.equal(disposed, true);
});
