# 资金日报

入口：`/fund-report`。公共规则见 [文档分流](../../AGENTS.md#context-routing)。仅在任务涉及本模块时读取。

## 接口

- `POST /api/fund-report`：上传单个 UTF-8 HTML，文件名末尾必须为 `YYYYMMDD.html` 或 `YYYY-MM-DD.html`。成功为 201。
- 请求体为原始 HTML 文件，`X-Fund-Report-Filename` 传 URL 编码的原文件名，`X-Fund-Report-Size` 传文件字节数。
- Worker 将文件保存为 R2 `fund-reports/YYYY-MM-DD.html`。同日报告再次上传会覆盖并在响应中返回 `replaced: true`。
- `GET /management`：303 跳转 `/management/me`。资金日报上传通过 `/fund-report` 的管理员控件进入。
- `GET /fund-report`：仅向 admin 显示上传按钮，点击后打开模态框，成功后定向刷新历史列表。以 `Cache-Control: no-store` 返回按日期倒序排列的历史资金日报列表。
- `GET /fund-report/YYYY-MM-DD.html`：从 R2 返回 HTML。无该日报为 404。

## 数据流

历史资金日报页的上传模态框上传完整 HTML → Worker 校验文件名日期、大小、编码和 HTML 文档头 → R2 `fund-reports/YYYY-MM-DD.html`。`/fund-report` 枚举固定前缀并按日期倒序展示历史列表。日期页只解析确定性的对象 key，不接受任意 R2 路径。

Data 的每日同步按交易日历回看最近14个自然日内已结束交易日的资金日报，接收迟传及同日更正；窗口内缺文件仍报告缺口，不提前要求当日报告。超过窗口的历史补录和更正使用 Data 的显式[资金日报回填](../../../data/docs/modules/quant-inputs.md#一次性回填)。
