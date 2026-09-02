# 仓库贡献指南

## 项目结构与模块划分

FishStock 是 TypeScript 编写的 VS Code 扩展。`src/extension.ts` 负责扩展激活、模块装配和生命周期管理。各目录职责如下：

- `src/domain/`：代码规范化、领域模型、上市板块和排序规则。
- `src/data/`：行情源接口、腾讯与新浪适配器、解析、缓存及北交所参考数据。
- `src/storage/`：带版本的本地自选数据持久化。
- `src/services/`：刷新调度。
- `src/ui/`：原生 Tree View、行情浮窗和唯一的状态栏项目。
- `src/commands/`：Stock 与 Futures 命令注册。
- `src/test/`：以 `*.test.ts` 命名的单元测试。

静态资源放在 `resources/`，产品和技术文档放在 `docs/`。`out/`、依赖目录、`*.vsix` 和本地 `docs/decisions.md` 不属于应提交的源文件。

## 构建、测试与本地开发

使用 Windows PowerShell 和 pnpm 11：

- `pnpm install`：按锁文件安装开发依赖。
- `pnpm run compile`：以严格模式编译 TypeScript 到 `out/`。
- `pnpm run lint`：执行 ESLint 检查。
- `pnpm test`：编译后运行全部单元测试。
- `pnpm run check`：依次执行 lint、编译和测试。
- `pnpm run test:smoke`：在隔离用户目录中启动 VS Code Extension Host 冒烟测试。
- `pnpm run release:check`：执行完整发布门槛并生成当前版本 VSIX。
- `pnpm run package:vsix`：验证并生成本地 VSIX，不进行发布。

在 VS Code 中按 `F5` 启动 Extension Development Host。

### 本机实际执行方式（优先）

Git Bash 里没有 pnpm，PowerShell 工具不回显 stdout，因此统一用**托管 node 绝对路径**直接调 `node_modules` 里的 bin：

```
N=C:/Users/18085/.workbuddy/binaries/node/versions/22.22.2-2/node.exe
"$N" ./node_modules/typescript/bin/tsc -p tsconfig.json
"$N" ./node_modules/eslint/bin/eslint.js .
"$N" --test out/test/*.test.js
"$N" scripts/run-smoke-tests.mjs      # Extension Host 冒烟：成功时静默无输出，exit 0 即通过
"$N" scripts/verify-release.mjs       # 版本一致性 + Marketplace 元数据 + 包内容校验
```

打包 VSIX（Git Bash 无 pnpm）：

```
node node_modules/@vscode/vsce/vsce package --no-dependencies
node scripts/verify-release.mjs --packaged --channel=stable
```

## 编码风格与命名

遵循现有 TypeScript 风格：两空格缩进、使用分号和单引号。函数及变量使用 `camelCase`，类和类型使用 `PascalCase`。模块边界应使用明确类型，纯类型导入使用 `import type`。禁止使用 `any`。供应商字段必须限制在数据适配器内；优先使用 VS Code 原生组件，不随意引入 Webview、框架或复杂抽象。

## 测试规范

测试使用 `node:test` 和 `node:assert/strict`。解析、代码规范化、存储变更、缓存、调度和数据源过滤都应有针对性测试。修复缺陷时必须增加回归用例。测试应使用固定响应样本或注入的请求函数，不依赖在线行情接口。提交审查前运行 `pnpm run check`。

## 提交与 Pull Request

提交信息采用 Conventional Commits 英文类型前缀和简洁中文结果描述，例如 `fix: 修复了北交所股票搜索`、`feat: 增加了期货默认数据`。每个提交保持单一目的，避免混入无关格式调整。

版本号采用 `主版本.次版本.修订版本`。规划中的功能里程碑滚动次版本号；交互优化、性能优化、缺陷修复和文档修正只滚动第三位修订版本号。

**版本与 tag**：**v1.0 之前不打 git tag**（2026-08-29 用户决定）。历史 tag 停在 `v0.3.9`，0.4.0 之后一直没打过。版本以 `package.json` 的 `version` + `CHANGELOG.md` 最新条目为准，由 `scripts/verify-release.mjs` 校验一致。README 的版本声明有硬格式：必须包含 `X.Y.Z 是` 这一段，否则 `verify-release.mjs` 直接失败。

**提交拆分惯例**：一个版本通常拆两个提交——功能提交（`feat`/`fix`/`perf`，只含源码）+ `chore: 完成了 X 发布准备`（CHANGELOG / README / docs / `package.json`）。不提交：密钥、用户自选数据、生成的 VSIX、`out/`、`docs/decisions.md`。

用户和开发者可以随时提出反馈，但不参与固定版本流程。维护者必须独立完成 `docs/release-checklist.md`，并以 `pnpm run release:check` 通过作为版本完成的必要条件。

Pull Request 应说明变更范围、验证命令及数据源或存储影响。涉及 Tree View、浮窗等可见变化时附截图。不要提交密钥、用户自选数据、生成的 VSIX 或无关文件。

## 产品边界（改动前先确认）

以下均明确不做，不在 `docs/product.md` 目标范围内：汇率换算与多币种合计、已实现收益持久化、交易流水、税费与手续费、K 线盘口、资产曲线、提醒与下单、账户与自有服务器、遥测、持仓自定义分组。

持仓只支持 A 股、港股、境内 ETF；期货持仓不在范围内。

## 项目上下文文件

- 第二层（项目规则）：本文件 `AGENTS.md`。
- 第三层（项目本地记忆）：`.local/memory.md` —— 决策编年史、本机环境坑、发布历史。
- 历史工作日志：`.local/archive/`。

## 安全与产品边界

用户数据只通过 VS Code `globalState` 保存。未经明确批准，不得增加遥测、账户、FishStock 自有服务、许可证或 Marketplace 发布流程。新增行情端点时必须保留数据源适配器边界，并记录市场覆盖、认证方式、限频和使用限制。
