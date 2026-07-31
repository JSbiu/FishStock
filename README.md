# FishStock

FishStock 是一个轻量、安静、本地优先的 VS Code 自选股行情插件。

当前版本使用腾讯行情接口，优先支持 A 股和港股。

## 当前功能

- Activity Bar 中的 FishStock 入口
- 原生 Tree View，两层结构为“分组 → 股票”
- 按中文名称、拼音简称或代码搜索 A 股与港股，预览结果后添加
- 从视图标题栏或目标分组直接添加股票
- 删除、跨组移动以及上移/下移股票
- 添加、重命名、删除和折叠分组
- 手动刷新与自动刷新
- 单个状态栏行情项目，按“股票名称 + 现价 + 涨跌幅”轮播，点击可打开自选列表
- 股票列表与状态栏共享原生行情浮窗，展示日内价格、成交、PE(TTM) 和总市值
- 腾讯 A 股与港股真实行情
- A 股与港股代码规范化
- 本机自选数据持久化
- JSON 导入、导出，以及带确认的清空与恢复默认数据
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
4. 用视图标题栏的添加和刷新按钮验证核心流程；将鼠标移到分组上或右键分组，可直接向该组添加股票。

首次运行会创建“默认”分组，并放入 `600519.SH` 和 `00700.HK` 两只示例股，可随时删除。

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

自选列表保存在当前 VS Code Profile 的本机 `globalState` 中，卸载或升级扩展不会自动删除。命令面板和 Stock 视图的 `…` 菜单提供两个独立操作：“清空全部自选数据”会保留一个空的“默认”分组；“恢复默认自选数据”会恢复首次运行的默认分组、贵州茅台和腾讯控股。两者均需要确认。导入、导出只会在用户主动选择文件后进行。

本软件仅用于行情辅助展示，不提供投资建议。
