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
- `pnpm run package:vsix`：验证并生成本地 VSIX，不进行发布。

在 VS Code 中按 `F5` 启动 Extension Development Host。

## 编码风格与命名

遵循现有 TypeScript 风格：两空格缩进、使用分号和单引号。函数及变量使用 `camelCase`，类和类型使用 `PascalCase`。模块边界应使用明确类型，纯类型导入使用 `import type`。禁止使用 `any`。供应商字段必须限制在数据适配器内；优先使用 VS Code 原生组件，不随意引入 Webview、框架或复杂抽象。

## 测试规范

测试使用 `node:test` 和 `node:assert/strict`。解析、代码规范化、存储变更、缓存、调度和数据源过滤都应有针对性测试。修复缺陷时必须增加回归用例。测试应使用固定响应样本或注入的请求函数，不依赖在线行情接口。提交审查前运行 `pnpm run check`。

## 提交与 Pull Request

提交信息采用 Conventional Commits 英文类型前缀和简洁中文结果描述，例如 `fix: 修复了北交所股票搜索`、`feat: 增加了期货默认数据`。每个提交保持单一目的，避免混入无关格式调整。

Pull Request 应说明变更范围、验证命令及数据源或存储影响。涉及 Tree View、浮窗等可见变化时附截图。不要提交密钥、用户自选数据、生成的 VSIX 或无关文件。

## 安全与产品边界

用户数据只通过 VS Code `globalState` 保存。未经明确批准，不得增加遥测、账户、FishStock 自有服务、许可证或 Marketplace 发布流程。新增行情端点时必须保留数据源适配器边界，并记录市场覆盖、认证方式、限频和使用限制。
