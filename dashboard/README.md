# 市场研究 Dashboard

面向固定收益与市场研究人员的可视化应用。

## 功能

- 市场点评：资金面、利率债、信用债、权益、一级发行、二级成交，提供视觉版与文字版，可导出高分辨率图片。
- 市场热点：读取研报结构化证据，手动生成快照。首次访问展示最近成功结果。
- 二级池：浏览器解析 Excel，线上校验后写入 Neon，生成运营周报。原持仓成交分析页保留为隐藏深链。
- 融资择时模型：读取 Quant 结构化快照，展示发行建议、未来窗口、驱动因素和卖方观点。
- 交易研究工作台：交易管理、市场热点、政策跟踪、研究辅助、流程中心、二级池周报和融资择时模型。
- 授信工作台：授信一览表、日历和周报。公开材料问答由全站 AI 侧栏提供。
- 融资工作台 `/financing`：仪表盘、项目、SOP、负债周报和数据后台。管理中心在 `/management/*`。

公网认证和权限由 [Gateway](../gateway/AGENTS.md) 处理，本 Worker 只经命名 Service Binding 接入。

## 本地运行

```bash
pnpm install
pnpm dev
```

入口为 `http://127.0.0.1:8765/`。环境配置见 [DEVELOPMENT](docs/DEVELOPMENT.md#本地环境)。

## 文档

从 [AGENTS](AGENTS.md) 进入，按 [Context Routing](AGENTS.md#context-routing) 选读。UI 任务加读 [DESIGN](DESIGN.md)。跨项目架构、存储和 AI 规范见 [项目组 AGENTS](../AGENTS.md#context-routing)。
