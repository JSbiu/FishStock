import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vsce from '@vscode/vsce';
import vsceZip from '@vscode/vsce/out/zip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const privacy = readFileSync(resolve(root, 'PRIVACY.md'), 'utf8');
const support = readFileSync(resolve(root, 'SUPPORT.md'), 'utf8');
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
if (manifest.publisher !== 'jsbiu') {
  throw new Error(`publisher 必须为 jsbiu，当前为 ${manifest.publisher ?? '缺失'}`);
}
if (manifest.license !== 'MIT') {
  throw new Error(`license 必须为 MIT，当前为 ${manifest.license ?? '缺失'}`);
}
if (manifest.preview !== true) {
  throw new Error('0.5.1 Marketplace 发布必须标记为 Preview');
}
if (manifest.pricing !== 'Free') {
  throw new Error('0.5.1 Marketplace 定价标记必须为 Free');
}
if (!privacy.includes('不会收集或上传遥测')) {
  throw new Error('PRIVACY.md 缺少无遥测声明');
}
if (!support.includes('复制运行诊断信息')) {
  throw new Error('SUPPORT.md 缺少诊断信息指引');
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
  'license',
  'privacy.md',
  'support.md',
  'out/extension.js',
  'resources/fishstock.png',
  'resources/fishstock.svg',
];
for (const required of requiredFiles) {
  if (!lowerFiles.includes(required)) {
    throw new Error(`VSIX 缺少必要文件：${required}`);
  }
}

const forbiddenPrefixes = [
  '.agents/',
  '.github/',
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
  const packaged = await vsceZip.readVSIXPackage(packagePath);
  const packageProperties = packaged.xmlManifest.PackageManifest.Metadata[0].Properties[0].Property;
  const isPreRelease = packageProperties.some(
    (property) => property.$.Id === 'Microsoft.VisualStudio.Code.PreRelease',
  );
  if (!isPreRelease) {
    throw new Error('VSIX 未标记为 Marketplace 预发布包');
  }
}

process.stdout.write(`FishStock ${version} 发布校验通过，VSIX 源文件数：${files.length}\n`);
