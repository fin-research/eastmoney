# 市场研究 Dashboard

面向固定收益与市场研究人员的可视化应用。统一呈现每日市场点评、市场热点、二级债券池运营周报、融资择时与交易研究工作台。

## 核心功能

- 市场点评：展示资金面、利率债、信用债、权益、一级发行、二级成交等结构化数据，并提供视觉版与文字版。
- 市场热点：读取研报结构化证据，手动生成热点快照。首次访问直接展示最近成功结果。
- 二级池：在浏览器解析 Excel，线上校验并直接写入 Neon 后生成运营周报。原持仓成交分析页保留为隐藏深链。
- 融资择时模型：读取 quant 结构化快照，展示发行建议、未来窗口、驱动因素和卖方观点。
- 交易研究工作台：交易管理、市场热点、政策跟踪、研究辅助、流程中心、二级池周报和融资择时模型。
- 授信工作台：授信一览表、授信日历和授信周报。公开材料问答通过全站 AI 侧栏提供。机构详情显式保存。
- 报告导出：把当前报告正文导出为高分辨率图片。

## 基本使用

```bash
pnpm install
pnpm dev
```

本地入口为 `http://127.0.0.1:8765/`。开发服务器通过 `.env.dev` 配置的数据代理读取 `/data/*`，不会自动同步线上 D1。

## 文档

开发从 [AGENTS](AGENTS.md) 进入，再按 [页面与模块分流](AGENTS.md#context-routing) 阅读。UI 任务加读 [DESIGN](DESIGN.md)，本地运行与验证见 [DEVELOPMENT](docs/DEVELOPMENT.md)。跨项目架构、存储和 AI 规范集中在 [项目组 AGENTS](../AGENTS.md#context-routing)。

## 融资工作台与管理中心

融资业务已合并到 Dashboard，继续从 `/financing` 进入仪表盘、项目、SOP、负债周报和数据后台。`/management/people` 是管理员人员资料与角色权限界面。个人资料、权限与通知分别进入 `/management/me`、`/management/permissions`、`/management/notifications`。旧 `/profile` 重定向到“我的”。公网认证和权限由独立 Gateway 处理，本 Worker 只通过命名 Service Binding 接入。业务数据仍使用原 Neon `financing` schema 与原 R2 周报快照。

开发前按 [文档分流](AGENTS.md#context-routing) 选择目标模块。公共 UI、认证、数据库和发布规则统一维护，旧 financing 仓库仅保留历史。
