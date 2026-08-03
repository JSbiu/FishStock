import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'out', 'smoke', 'suite.js');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'fishstock-smoke-'));
const userDataDir = join(temporaryRoot, 'user-data');
const extensionsDir = join(temporaryRoot, 'extensions');
mkdirSync(userDataDir);
mkdirSync(extensionsDir);

function resolveCodeCli() {
  const configured = process.env.FISHSTOCK_VSCODE_EXECUTABLE;
  if (configured) {
    return { command: configured, args: [], env: process.env };
  }
  if (process.platform !== 'win32') {
    return { command: 'code', args: [], env: process.env };
  }

  const lookup = spawnSync('where.exe', ['code.cmd'], { encoding: 'utf8' });
  const commandPath = lookup.stdout?.split(/\r?\n/).find(Boolean);
  if (!commandPath) {
    throw new Error('未找到 VS Code CLI；请设置 FISHSTOCK_VSCODE_EXECUTABLE');
  }
  const installRoot = resolve(dirname(commandPath), '..');
  const executable = join(installRoot, 'Code.exe');
  const cli = readdirSync(installRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(installRoot, entry.name, 'resources', 'app', 'out', 'cli.js'))
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  if (!existsSync(executable) || !cli) {
    throw new Error(`VS Code CLI 安装不完整：${installRoot}`);
  }
  return {
    command: executable,
    args: [cli],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' },
  };
}

const code = resolveCodeCli();
const args = [
  ...code.args,
  '--new-window',
  '--wait',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${extensionsDir}`,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${suite}`,
  root,
];

try {
  const result = spawnSync(code.command, args, {
    cwd: root,
    env: code.env,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Extension Host 冒烟测试失败，退出码 ${result.status ?? '未知'}`);
  }
} finally {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}
