# 今日聚焦

入口：`/market-briefing`。公共规则见 [文档分流](../../AGENTS.md#context-routing)。仅在任务涉及本模块时读取。

日常生成由 `market-briefing` Workflow 的 `generate-focus` 步骤执行，直接消费七个并行模块之一 `collect-focus-news` 整理完成的 DM 新闻材料。AI 步骤不重新取材，adapter 关闭内部重试，由 step 配置统一管理。页面初次只读取已归档聚焦，有写权限时可直接编辑。点击星标 AI 生成按钮才调用以下 POST，失败保留当前内容，成功替换后仍可编辑。修改后的内容由 header 导出并发下载图片和归档报告。

日常 Workflow 今日聚焦不依赖权益模块，也不取股票收评。`collect-focus-news` 分批读取 Data 返回的正文，完成筛选和组装。人工重新生成 POST 接口仍保留股票收评与 DM 新闻合并取材。

## 接口

- `POST /api/market-briefing?date=YYYY-MM-DD`：日期默认时使用上海时区当天。前端携带 `Accept: text/event-stream` 时返回统一 `progress/result/error` SSE，`progress` 为纯文本 summary，`result` 为完整市场点评 JSON。
- 无效日期为 400。上游、模型或配置错误按路由映射为 5xx。
- 模型通过 provider-specific Responses API 调用，启用 `web_search`、使用统一 `xhigh` reasoning effort，并将 AI Gateway 请求超时设为 300 秒。联网证据仅用于补充、核验给定材料未充分解释的关键行情和驱动。

## 业务规则

- Dashboard Worker 通过 `DATA` Service Binding 分别请求 `/data/stock-summary`、`/data/news?detail=true&pageSize=10&offset=…`，在本项目拼接新闻素材后调用统一 AI Gateway 适配器。生成时启用 Responses `web_search` 和统一 `xhigh` reasoning effort，输出仍为两条纯文本。
- 新闻正文读取与分页由 Data 提供；新闻筛选与提示词格式属于 Dashboard Worker 契约。更改时必须同步检查 `data` 与本项目测试。

新闻在原 `collect-focus-news` 内顺序读取最多四批，每批通过 `/data/news?detail=true&pageSize=10&offset=…` 返回正文。四批固定同一 `endTime`，按 ID 检查重复，任何批次失败则整个模块失败，由原 step 重试，不创建独立新闻 Workflow。Data 内详情最多五个并发。
