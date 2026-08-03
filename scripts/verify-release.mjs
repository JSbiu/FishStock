import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vsce from '@vscode/vsce';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const version = manifest.version;

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('package.json version 必须是主版本.次版本.修订版本');
}
const latestChangelog = changelog.match(/^## (\d+\.\d+\.\d+)$/m)?.[1];
if (latestChangelog !== version) {
  throw new Error(`CHANGELOG 最新版本 ${latestChangelog ?? '缺失'} 与 ${version} 不一致`);
}
if (!readme.includes(`${version} 是`)) {
  throw new Error(`README 未声明当前版本 ${version}`);
}

const files = (await vsce.listFiles({
  cwd: root,
  packageManager: vsce.PackageManager.None,
  packagedDependencies: [],
})).map((file) => file.replaceAll('\\', '/'));
const lowerFiles = files.map((file) => file.toLowerCase());
const requiredFiles = [
  'package.json',
  'readme.md',
  'changelog.md',
  'out/extension.js',
  'resources/fishstock.svg',
];
for (const required of requiredFiles) {
  if (!lowerFiles.includes(required)) {
    throw new Error(`VSIX 缺少必要文件：${required}`);
  }
}

const forbiddenPrefixes = [
  '.agents/',
  '.vscode/',
  'scripts/',
  'src/',
  'out/test/',
  'out/smoke/',
];
const forbiddenFiles = new Set([
  'agents.md',
  '.gitignore',
  'eslint.config.mjs',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
]);
for (const file of lowerFiles) {
  if (
    forbiddenFiles.has(file)
    || forbiddenPrefixes.some((prefix) => file.startsWith(prefix))
    || file.endsWith('.vsix')
    || file.endsWith('.map')
  ) {
    throw new Error(`VSIX 包含禁止文件：${file}`);
  }
}

if (process.argv.includes('--packaged')) {
  const packagePath = resolve(root, `fish-stock-${version}.vsix`);
  if (!existsSync(packagePath) || statSync(packagePath).size === 0) {
    throw new Error(`未生成有效 VSIX：${packagePath}`);
  }
}

process.stdout.write(`FishStock ${version} 发布校验通过，VSIX 源文件数：${files.length}\n`);
