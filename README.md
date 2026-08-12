<p align="center">
  <img src="resources/fishstock.png" width="128" height="128" alt="FishStock 图标">
</p>

# FishStock

FishStock 是一个轻量、安静、本地优先的 VS Code 自选行情扩展。在不离开编辑器的情况下，用原生侧边栏快速查看少量股票、指数、ETF 和国内商品期货。

0.5.6 是一次启动边界修复：FishStock 不再在启动时主动打开任何 View；全新工作区首次进入 FishStock 时使用 VS Code 原生的默认展开布局，之后尊重用户保存的折叠状态。FishStock 不要求账户，不上传自选数据，不提供投资建议；行情来自第三方公开网页端点，可能受到地区、网络和访问策略影响。

## 主要特点

- 原生 `Stock`、`Fund` 与 `Futures` 同级 Tree View，保持简洁的“分组 → 自选条目”结构。
- 股票支持 A 股、港股、常见市场指数、科创板和北交所新旧代码。
- Fund 当前支持沪深交易所 ETF，可按名称、拼音简称或代码搜索，例如“电网设备ETF”或 `159326`。
- Futures 支持国内商品期货主连和当前有效月份合约。
- 一个安静的状态栏项目轮播“名称 + 现价 + 涨跌幅”，可按现有自选分组选择轮播范围。
- 支持分组、排序筛选、全部展开、手动与自动刷新、清空和恢复默认。
- 浮窗展示价格、涨跌、成交及适用品种的更多字段。
- 自选数据保存在当前 VS Code Profile，本扩展没有账户、遥测或自有服务器。
- 可主动复制脱敏诊断信息，帮助反馈问题，不会自动上传日志。

## 快速开始

1. 从 VS Code 扩展市场安装 FishStock。
2. 点击 Activity Bar 中的 FishStock 图标。
3. 在 `Stock`、`Fund` 或 `Futures` 标题栏点击 `+`，搜索并确认条目。
4. 将鼠标悬停在条目上查看详情，点击条目可在浏览器打开外部行情页面。

| 操作 | 入口 |
| --- | --- |
| 添加股票或指数 | `Stock` 标题栏或目标分组的 `+` |
| 添加 ETF | `Fund` 标题栏或目标分组的 `+` |
| 添加期货 | `Futures` 标题栏或目标分组的 `+` |
| 删除、移动、调整顺序 | 右键具体条目 |
| 添加、重命名、删除分组 | 视图标题栏或分组右键菜单 |
| 全部展开或全部折叠 | 对应视图标题栏 |
| 排序和涨跌筛选 | 对应视图标题栏的排序按钮 |
| 手动刷新 | 对应视图标题栏的刷新按钮 |
| 选择状态栏轮播分组 | 任一视图标题栏的 `...` 菜单，或命令面板 |
| 清空或恢复默认 | 对应视图标题栏的 `...` 菜单，执行前会确认 |
| 复制脱敏诊断信息 | 命令面板，或视图标题栏的 `...` 菜单 |

股票搜索示例：`美的集团`、`mdjt`、`000333`。ETF 搜索示例：`电网设备ETF`、`dwsbetf`、`159326`。期货搜索示例：`沪金`、`AU0`、`AL2608`。搜索结果会先预览，只有确认后才写入自选。

## 支持范围

| 品类 | 当前支持 | 暂不支持 |
| --- | --- | --- |
| Stock | A 股、港股、A 股与港股常见指数 | 美股、投资组合和历史走势 |
| Fund | 沪深交易所 ETF | 场外基金、ETF 联接基金、LOF、港股 ETF |
| Futures | 国内商品期货主连和有效月份合约 | 金融期货、期权、外盘期货 |

首次创建本地数据时，Stock 提供少量股票、指数和银行示例，Fund 提供沪深300ETF示例，Futures 提供沪金、白银、铜、沪铝和锡主连示例。升级扩展不会覆盖已有自选。

## 配置

| 配置 | 默认值 | 有效范围 | 说明 |
| --- | ---: | ---: | --- |
| `fishStock.refreshIntervalSeconds` | 60 秒 | 15–3600 秒 | 自动刷新间隔 |
| `fishStock.staleAfterSeconds` | 120 秒 | 30–86400 秒 | 开市行情超过该时间未更新时标记为“数据过期” |
| `fishStock.statusBar.rotationSeconds` | 5 秒 | 3–60 秒 | 状态栏轮播间隔，不触发网络请求 |
| `fishStock.colorConvention` | `china` | `china` / `international` | 涨红跌绿 / 涨绿跌红 |

## 行情可用性

Stock、Fund 使用腾讯公开网页行情端点，Futures 使用新浪公开网页行情端点。这些端点没有面向 FishStock 的正式接口契约，字段、访问策略和可用地区可能变化。

某个行情源返回 HTTP 403 后，对应模块的自动刷新会按 15 分钟、30 分钟、1 小时、2 小时、最长 6 小时递增退避，避免持续重复请求。手动刷新仍可立即重新探测。行情失败时优先保留最近一次成功数据并明确标记为“数据过期”或“暂不可用”。

股票、ETF 和期货后台刷新分别判断自己的交易日。当前不按股票午休、收盘或期货分品种夜盘精确暂停；完整边界见[行情源说明](docs/data-sources.md)。

## 原生视图布局

`Stock`、`Fund` 与 `Futures` 是可独立显示或隐藏的 VS Code 原生 View，首次布局提供 `2:1:1` 高度权重，并在全新工作区中默认展开。FishStock 不在 VS Code 启动时打开侧边栏，也不在用户展开某个 View 时联动其他 View。之后的分组折叠状态和 View 高度继续由 VS Code 保存，扩展不强制重设原生分隔位置。

如果重新展开的 View 占用了过多空间，请拖动分隔线；同时展开相邻 View 后双击分隔线，可以使用 VS Code 的原生均分行为。FishStock 不会在启动时强制聚焦或展开 View，以免抢占编辑器焦点并覆盖用户布局。

## 数据与隐私

自选分组保存在当前 VS Code Profile 的本机 `globalState` 中。FishStock 不读取工作区文件，也不会收集或上传遥测。为了完成搜索和行情，用户输入的搜索文本或自选代码会由本机直接发送给腾讯、新浪或北交所公开站点，不经过 FishStock 服务器。

完整说明见[隐私说明](PRIVACY.md)。

## 问题反馈

遇到问题时，可以执行 `FishStock: 复制运行诊断信息`，再通过 [GitHub Issues](https://github.com/JSbiu/FishStock/issues) 提交。诊断报告不包含自选名称、证券代码、文件路径或工作区信息。刷新错误可在“查看 → 输出 → FishStock”中查看。

反馈前请阅读[支持说明](SUPPORT.md)。

## 本地开发

要求 VS Code 1.90 或更高版本、Node.js 20 或更高版本以及 pnpm 11。

```powershell
pnpm install
pnpm run check
pnpm run test:smoke
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

生成稳定通道 VSIX：

```powershell
pnpm run package:vsix
```

生成预发布通道 VSIX：

```powershell
pnpm run package:vsix:pre-release
```

命令会执行 lint、单元与回归测试、真实 Extension Host 冒烟、版本和 Marketplace 元数据校验、包内容检查，并生成 `fish-stock-<version>.vsix`。

## 许可证与声明

FishStock 使用 [MIT License](LICENSE)。

本软件仅用于行情辅助展示，不提供投资建议。第三方行情可能延迟、不完整、不准确或不可用，任何投资决策及其结果均由用户自行承担。
