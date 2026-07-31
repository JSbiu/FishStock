# FishStock

FishStock 是一个轻量、安静、本地优先的 VS Code 自选行情插件。

当前版本优先支持 A 股、港股、市场指数和国内商品期货。

## 当前功能

- Activity Bar 中的 FishStock 入口
- 原生 `Stock` 与 `Futures` 同级 Tree View，均保持“分组 → 自选条目”两层结构
- 按中文名称、拼音简称或代码搜索 A 股、港股及指数，支持科创板和北交所新旧代码，预览结果后添加
- 从视图标题栏或目标分组直接添加个股或指数
- 删除、跨组移动以及上移/下移自选条目
- 添加、重命名、删除和折叠分组
- 手动刷新与自动刷新
- 单个状态栏行情项目，按“名称 + 现价 + 涨跌幅”轮播，点击可打开自选列表
- 个股浮窗展示日内价格、成交、PE(TTM)、总市值和上市板块
- 腾讯 A 股、港股及市场指数真实行情
- 新浪国内期货真实行情，支持按中文品种或代码添加主连与当前有效月份合约
- A 股、港股和指数代码规范化，包括北交所 `920` 代码识别
- 本机自选数据持久化
- 股票与期货自选分别支持带确认的清空和恢复默认数据
- 中文涨红跌绿、国际涨绿跌红配置
- 请求合并、短时缓存和数据过期状态

## 开发运行

要求：

- Windows 10 或更高版本
- VS Code 1.90 或更高版本
- Node.js 20 或更高版本
- pnpm 11

在项目目录执行：

```powershell
pnpm install
pnpm run check
```

然后在 VS Code 中：

1. 打开本项目。
2. 按 `F5`，或从“运行和调试”选择“运行 FishStock 扩展”。
3. 在新打开的 Extension Development Host 左侧 Activity Bar 点击 FishStock 图标。
4. 用 `Stock` 或 `Futures` 视图标题栏的添加和刷新按钮验证核心流程；将鼠标移到分组上或右键分组，可直接添加到该组。

首次运行会创建股票三组默认数据：“默认”包含贵州茅台和腾讯控股；“指数”包含上证指数、沪深300和创业板指；“银行”包含工商银行、农业银行、中国银行、建设银行、交通银行和邮储银行。期货“默认”分组包含沪金主连、白银主连、铜主连、沪铝主连和锡主连。所有条目都可随时删除。`Stock` 与 `Futures` 视图首次显示时默认展开，并按 `2:1` 分配初始高度；之后 VS Code 会记住用户的折叠和尺寸选择。已有工作区可在两个视图都展开后双击分隔线，将当前高度均分并重新保存。

## 本地 VSIX

```powershell
pnpm run package:vsix
```

命令会根据当前扩展版本在项目根目录生成 `fish-stock-<version>.vsix`。可在 VS Code 的 Extensions 视图中选择“Install from VSIX...”进行本地安装。当前阶段不要发布到 Marketplace。

## 配置

- `fishStock.refreshIntervalSeconds`：自动刷新间隔，默认 60 秒，下限 15 秒。
- `fishStock.staleAfterSeconds`：开市行情过期阈值，默认 120 秒。
- `fishStock.statusBar.rotationSeconds`：状态栏轮播间隔，默认 5 秒。
- `fishStock.colorConvention`：`china` 为涨红跌绿，`international` 为涨绿跌红。

## 项目文档

- [产品范围](docs/product.md)
- [架构设计](docs/architecture.md)
- [行情源调研](docs/data-sources.md)

## 数据与隐私

股票与期货自选分别保存在当前 VS Code Profile 的本机 `globalState` 中，卸载或升级扩展不会自动删除。北交所公开证券目录也会保存一份本地缓存，它不包含用户数据。Stock 视图可清空或恢复首次运行的“默认”“指数”“银行”三组数据；Futures 视图可清空或恢复五个默认主连合约，所有清空或替换操作均需要确认。

本软件仅用于行情辅助展示，不提供投资建议。
