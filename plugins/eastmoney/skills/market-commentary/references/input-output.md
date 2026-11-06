# 文件契约

所有命令在任何工作目录都可运行（脚本只通过自身相对路径读取 `core.mjs`），无环境变量、网络请求、运行时安装或本机项目依赖。Node.js 版本至少 20。命令写法见 SKILL.md。

> 自动化：`scripts/assemble.mjs` 从 `responses/` 目录组装下面的 raw.json 并直接跑 prepare，通常无需手写 raw.json；以下字段契约供理解产物结构与审计。

## live raw.json

以下示意用占位符描述结构，不能将示意空数组用作真实取数结果。时间必须为实际带时区 ISO 时间。

```json
{
  "report_date": "YYYY-MM-DD",
  "cutoff_at": "固定的新闻截止时间",
  "started_at": "实际采集开始时间",
  "completed_at": "实际采集完成时间",
  "calendar": {"date":"YYYY-MM-DD","isTradingDay":true,"previousTradingDate":"实际上一交易日"},
  "resources": {
    "omo": [], "dr": [], "dibo": [], "governmentBonds": [], "futures": [],
    "industry": {"dataDate":"YYYY-MM-DD","equities":[],"industries":[],"turnoverYi":null,"turnoverChangeYi":null},
    "margin": [], "primary": [], "todayTrades": [], "favoriteQuotes": [], "bondInfos": []
  },
  "provenance": [
    {"resource":"calendar","tool":"trading_days","args":{"date":"YYYY-MM-DD"},"fetched_at":"实际完成时间"}
  ],
  "news_batches": [{"offset":0,"endTime":"与cutoff_at完全一致","items":[]}]
}
```

`provenance` 对 calendar 与全部 resources 键各有记录；`tool` 是实际短名或带 `_短名` 后缀的完整工具名（如 `mcp__plugin_eastmoney_eastmoney__omo`），`args` 保存真实参数。分批基础信息记录多行。资源列表保存从成功响应中解包的 DTO；空值保留 null，不删除未知数值、不预先改单位。`news_batches.items` 每条需 sentimentId、title、time、tags、content，可有 important、link；允许单条 content为空，不能整批材料为空。

## archive raw.json

```json
{
  "report_date": "YYYY-MM-DD",
  "cutoff_at": "同日快照generated_at或用户指定的更晚历史时间",
  "snapshot": {"report_date":"YYYY-MM-DD","其他字段":"完整market_report返回对象"},
  "provenance": [{"resource":"snapshot","tool":"market_report","args":{"query":{"date":"YYYY-MM-DD"}},"fetched_at":"本次实际读取时间"}],
  "news_batches": [{"offset":0,"endTime":"与cutoff_at一致","items":[]}]
}
```

需要保留新闻调用的原响应与时间；可在 provenance 增加 `resource="news"`、`tool="news_list"` 的记录，或单独保存 tool-responses.json。工具原响应中若有失败结果，不得调用 prepare 当成成功集。

## 模型 composition.json

```json
{
  "report_date": "YYYY-MM-DD",
  "stock": "不带序号的股市聚焦，100—140字、最多160字，完整收句。",
  "bond": "不带序号的债市聚焦，同上。",
  "stock_paragraphs": ["基于同日行情的事实性股票收评。", "同一分类的行业强弱，可选第二段。"],
  "citations": [{"news_id":"news.json内真实sentimentId","claim":"该新闻支持的具体催化事实；注明盘中已知/盘后信息"}]
}
```

主因须有引用，行情事实直接对应 evidence.json。citations 是支持关系记录，不是让模型编造新闻。render严格校验引用ID存在、日期、最多160字和完整收句；100—140目标在 review.json中提示。事实与因果仍由模型复核。

## 交付

prepare输出 prepared.json（规范行情、过滤新闻、证据卡、取数审计）、evidence.json、news.json。`text <prepared.json> <composition.json>` 将完整文字版输出到 stdout，模型直接回复全文，不创建或交付TXT替代。`render <prepared.json> <composition.json> <输出目录>` 输出单文件可视化 HTML、report.json、review.json。report.json 是本次生成物，不能直接宣称已覆盖网站定稿；它不含网站归档所需 cached_at/finalized_at，也不自动上传。

HTML 是原 Dashboard 市场点评的可视化图片版：内嵌规范报告 JSON 和已打包的原 Svelte 组件、ECharts 图表与样式，与文字版共享数据和今日聚焦，离线打开即可显示全部图表，不读取本机仓库或外部服务。不得自行改版，详细契约见 [visual-contract.md](visual-contract.md)。来源和调用元数据只留在审计文件，不新增来源区或附录。
