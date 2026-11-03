# 资金日报

入口：`/fund-report`。

## 接口

- `POST /api/fund-report`：上传单个 UTF-8 HTML，文件名以 `YYYYMMDD.html` 或 `YYYY-MM-DD.html` 结尾，成功为 201。请求体为原始 HTML，`X-Fund-Report-Filename` 传 URL 编码的原文件名，`X-Fund-Report-Size` 传字节数（上限 20 MB）。
- Worker 校验文件名日期、大小、编码和 HTML 文档头，保存为 R2 `fund-reports/YYYY-MM-DD.html`。同日再次上传覆盖，响应含 `replaced: true`。
- `GET /fund-report`：按日期倒序列出历史报告，`Cache-Control: no-store`。仅 admin 显示上传按钮，成功后定向刷新列表。
- `GET /fund-report/YYYY-MM-DD.html`：从 R2 返回 HTML，无该日报告为 404。key 只由日期派生，列表只枚举固定前缀，key 规则见 [DATABASE](../DATABASE.md#r2)。

## 下游

Data 每日同步回看近 14 个自然日内已结束的交易日，接收迟传和同日更正。更早的补录用 Data 的[资金日报回填](../../../data/docs/modules/quant-inputs.md#一次性回填)。
