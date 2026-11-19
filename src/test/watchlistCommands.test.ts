import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildStockCommandSet } from '../commands/commandSets';
import type { WatchlistState } from '../domain/models';
import type { registerWatchlistCommands } from '../commands/registerWatchlistCommands';

test('watchlist mutations notify views that depend on group membership', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const state: WatchlistState = {
    version: 1,
    groups: [{ id: 'default', name: '默认', collapsed: false, stocks: [] }],
  };
  let refreshCalls = 0;
  let groupNotifications = 0;
  const modulePath = require.resolve('../commands/registerWatchlistCommands');
  const localRequire = createRequire(modulePath);
  const module = { exports: {} };
  runInNewContext(readFileSync(modulePath, 'utf8'), {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === 'vscode') {
        return {
          commands: {
            registerCommand: (
              command: string,
              handler: (...args: unknown[]) => unknown,
            ) => {
              handlers.set(command, handler);
              return { dispose: () => {} };
            },
          },
          window: {
            showInputBox: async () => '新分组',
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            setStatusBarMessage: () => {},
          },
          env: { openExternal: async () => {} },
          Uri: { parse: (value: string) => ({ value }) },
        };
      }
      return localRequire(name);
    },
    AbortController,
    setTimeout,
    clearTimeout,
  });
  const { registerWatchlistCommands: register } = module.exports as {
    registerWatchlistCommands: typeof registerWatchlistCommands;
  };
  register({
    repository: {
      getSnapshot: () => structuredClone(state),
      addGroup: async (_id: string, name: string) => {
        state.groups.push({
          id: `group-${state.groups.length}`,
          name,
          collapsed: false,
          stocks: [],
        });
      },
    } as never,
    search: async () => [],
    refresh: async () => {
      refreshCalls += 1;
    },
    expandAll: async () => {},
    viewOptions: {} as never,
    treeProvider: {} as never,
    set: buildStockCommandSet(),
    onRepositoryChange: () => {
      groupNotifications += 1;
    },
  });
  const addGroup = handlers.get('fishStock.addGroup');
  assert.ok(addGroup);
  await addGroup();
  assert.equal(state.groups.at(-1)?.name, '新分组');
  assert.equal(groupNotifications, 1);
  assert.equal(refreshCalls, 1);
});
