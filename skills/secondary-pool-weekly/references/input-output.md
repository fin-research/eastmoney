# MCP 记录与 CLI

## 增量上传台账

上传分两步，全部需要 `bond.ledger:import` 权限；xlsx 原件字节不经 MCP，直接写入 R2。

1. 申请直传地址：MCP 工具 `file_upload_request`，输入：

```json
{
  "body": {
    "purpose": "bond-ledger",
    "fileName": "二级资金池台账20261026.xlsx",
    "size": 4096,
    "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
}
```

返回 `{version, purpose, uploadId, key, uploadUrl, requiredHeaders, expiresAt, sizeLimit, contentType}`。`uploadUrl` 为 R2 预签名 PUT 地址，约 15 分钟有效；`requiredHeaders`（含 `Content-Type` 与 `If-None-Match: *`）是 PUT 必须原样发送的头，`upload.mjs put` 已按此发送（Content-Type 默认取申请时值）。

2. 直传原件：`node <本skill目录>/scripts/upload.mjs put <uploadUrl> <台账.xlsx> [contentType]`，把本地文件字节 PUT 到该地址（Content-Type 须与申请时一致）。

3. 完成导入：MCP 工具 `bond_ledger_import`，输入：

```json
{
  "body": {
    "uploadId": "<file_upload_request 返回的 uploadId>",
    "fileName": "二级资金池台账20261026.xlsx",
    "expectedDate": "2026-10-26",
    "parsed": {"date": "2026-10-26", "performance": [], "positions": []}
  }
}
```

服务端不解析 Excel，以直传原件归档并单事务入库。返回 `{reportDate, statisticsCount, positionCount, transactionCount}`。同一报表日重复上传会替换原成功记录（旧记录标记 superseded）。

本地准备命令：

```sh
node <本skill目录>/scripts/upload.mjs prepare <输出目录>/raw.json <上传输出目录> [扫描目录...]
```

脚本扫描目录（默认 `~/Downloads` 与微信容器 `xwechat_files/*/msg/file`），匹配“二级…台账*.xlsx”，按文件内容解析报表日并与 `raw.json` 的 `databaseDates` 增量对比，只为未入库日期生成 `<date>.json` 载荷（含 fileName/expectedDate/parsed/size，不含文件字节）和 `upload-manifest.json`。

清单字段：`pending`（待上传，含 date/fileName/path/size/payload）、`skipped`（already_imported/duplicate_date，含 reason）、`failed`（解析失败）、`databaseDates`。模型逐笔执行 file_upload_request → upload.mjs put → bond_ledger_import，成功后重新调用 `bond_ledger {}` 刷新 inventory，再进入 select/prepare/render。单文件原件须小于 12 MB。

## 输入

先调用 bond_ledger 空参数，建立 raw.json；日期与数据必须来自本次真实调用。下面省略号表示说明，不能写进 JSON。

```json
{
  "asOf": "2026-10-27",
  "inventory": {
    "tool": "eastmoney_bond_ledger",
    "arguments": {},
    "fetchedAt": "2026-10-27T10:00:00+08:00",
    "response": {
      "databaseDates": ["2026-10-22", "2026-10-23"],
      "availableStartDate": "2026-10-22",
      "availableEndDate": "2026-10-23"
    }
  }
}
```

`select raw.json` 返回所需 query，例如 start=2026-01-01、end=2026-10-23。模型自行调用同一 MCP 工具，把结果追加为：

```json
{
  "report": {
    "tool": "eastmoney_bond_ledger",
    "arguments": {"query": {"start": "2026-01-01", "end": "2026-10-23"}},
    "fetchedAt": "2026-10-27T10:01:00+08:00",
    "response": {"hasData": true}
  }
}
```

上例 response 仅展示位置；必须保存实际完整 BondLedgerReport，不能只有 hasData。支持原 MCP content JSON、structuredContent.data、宿主包装，或解包后的完整业务对象。保留原调用日志更利于核对；不要把同一 MCP 响应的 text 和 structuredContent 当成两份数据。错误、权限拒绝、schema不符和截断全部终止；不能填空数组模拟无数据。

用户明确指定范围时，在根对象加入 `"requestedRange":{"start":"2026-10-19","end":"2026-10-23"}`。asOf 必须不早于 end。两日期必须成对，不能用 date 参数下载文件。默认范围不使用 availableEndDate 直接决定，必须先过滤 databaseDates，排除未来及往年日期。

## MCP 输出字段

BondLedgerReport 包含 hasData/currentPerformance/performanceTrend/operatingTrend、两账户趋势、holdingTypes/maturityBuckets、tradingHoldingTypes/tradingMaturityBuckets/topTradingPositions、transactions/transactionTotals、区间收益与风险、metricDeltas、detailMarketValue、availability、auditChecks/auditPassed、effectiveStartDate/EndDate。MCP 只读此业务 DTO，不返回文件、R2 key、原始人员持仓或导入审计。

`currentPerformance`：date、principal、timeWeightedPrincipal、marketValue、leverage、modifiedDuration、dailyRevenue、cumulativeProfit、ytdAnnualizedReturn、ytdExTaxAnnualizedReturn。

`operatingTrend` 在上述字段上增加 tradingMarketValue、availableMarketValue、flatStatic、dv01、cumulativeTaxExemptProfit、cumulativeExTaxProfit、fullPoolYtdAnnualizedReturn、fullPoolYtdExTaxAnnualizedReturn。

`availability` 数值可为空；`auditChecks` 的三项包含 key、label、pass、actual、expected、difference、tolerance。任何缺失数据不得补零；所有金额输入均为元。

## prepare 输出

- review.json：ready / empty / audit_failed、查询与有效范围、审计明细。
- ready：prepared.json（保存真实输入）、evidence.json（指标与交易户结构）、composition-template.json。
- empty / audit_failed：仅 review.json 和 reconciliation.json；不生成正文或 HTML。不能继续 render。

## composition.json

```json
{
  "focus": [
    {"title": "规模与杠杆", "text": "依据本次数据撰写事实与下一步跟踪条件。", "evidencePaths": ["metrics.leverage", "metrics.marketValue"]},
    {"title": "利率风险", "text": "依据本次久期和 DV01 撰写。", "evidencePaths": ["metrics.dv01", "metrics.modifiedDuration"]},
    {"title": "流动性", "text": "依据期限结构撰写。", "evidencePaths": ["metrics.oneYearShare"]}
  ]
}
```

只能引用 evidence.json 中实际存在且非 null 的路径。字段检查不能证明文稿判断正确，模型必须逐句核对。不得直接交付模板文字。

## render 输出

secondary-pool-weekly.html：完整 HTML、CSS、内联 SVG；离线打开，无 npm 或浏览器端 JS 依赖。

report.json：与 HTML 同一份指标、文稿、完整 MCP 来源及输入 SHA256。review.json：本次校验结果。render 会重新从保存的真实输入执行校验，编辑 evidence 摘要不能绕过审计。每次任务使用单独输出目录，避免把旧文件混入交付。

包内 selftest.mjs 的数据都是测试夹具；只能用于验证脚本，不能作真实报告。所有 HTML 用户文字均转义。
