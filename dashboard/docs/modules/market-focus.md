# 今日聚焦

入口：`/market-briefing`。Workflow 编排、新闻采集和定稿存储见 [市场点评](market-briefing.md)。

## 生成与编辑

- 日常由 `generate-focus` 步骤生成。输入是 `collect-focus-news` 整理好的 DM 新闻和六个行情模块的规范数据，AI 步骤不重新取材。重试由 step 配置统一管理，adapter 不做内部重试。
- 页面首次只读已归档聚焦。有写权限的用户可直接编辑，修改后经 header 导出，同时下载图片并归档报告。
- 只有点击星标 AI 生成按钮才调用 `POST /api/market-briefing`。失败保留当前内容，成功替换后仍可编辑。

## 接口

`POST /api/market-briefing?date=YYYY-MM-DD`：日期默认为上海时区当天。

- 带 `Accept: text/event-stream` 时返回统一 `progress/result/error` SSE，`progress` 为纯文本 summary，`result` 为完整市场点评 JSON。无效日期 400，上游、模型或配置错误按路由映射为 5xx。
- 取材：经 `DATA` 取 `/data/stock-summary` 和 `/data/news?detail=true&pageSize=10&offset=…`，在 Dashboard 拼接素材。新闻筛选与提示词格式是 Dashboard 的契约，正文读取与分页由 Data 提供，改动时同步检查 `data` 与本项目测试。
- 行情证据复用同日 R2 定稿，定稿不存在时只用新闻。定稿损坏或存储错误直接失败。
- 模型走 Responses API，启用 `web_search`，`xhigh` reasoning effort，AI Gateway 超时 300 秒。通则见 [共享 AI](../../../docs/AI.md)。

## 写作与校验规则

- 优先使用给定新闻。联网搜索只在缺少核心判断所需信息时补充，得到信息即停止，缺乏支持的判断保留不确定性。
- 输出 `{stock, bond}` 两条非空纯文本，Workflow 按股、债顺序拼接 `1、` 和 `2、`。Schema 不设字符串 maxLength，避免结构化解码截断句子。
- 每条目标约 120 字（100—140，上限 160），以完整句收尾。超限或未完整收句视为失败：不返回、不归档，Workflow 按 step 策略重试，手动生成保持页面原稿。
- 写法：明确当日定性，选一至两个主因，结尾给方向和主要约束。不强制条件式展望、对称情景和机械“关注”尾句。行业、期限和收益率方向服从报告截面，新公布的消息不得倒推为此前行情的原因。
- 行情证据由 `market-briefing-evidence.ts` 投影：指数/成交、行业前三后三、资金利率、国债期限、期货和当日 OMO，保留空值和 OMO 到期金额的符号。行业数据日期不符时，同时排除对应指数、成交和行业数据。
- 不投影人工 `focus_text`、公司债持仓和无可信时点的旧 `stock_paragraphs`，人工点评不作为生成答案。

## 写作回放

```sh
node scripts/evaluate-market-briefing.mjs --request=<Gateway 原始请求 JSON> --date=YYYY-MM-DD --output-dir=<仓库外目录> [--report=<同日归档 JSON>] [--baseline]
```

- 经统一 AI adapter 实际调用模型，凭据取进程环境变量 `CF_AIG_TOKEN`，不放参数或文件。不调用搜索、Data、R2 写入、Workflow 或消息。
- 只提取请求中的 user 文本。新闻须包含报告日且无未来日期。`--report` 只投影行情，省略则固定原始新闻。`--baseline` 用历史 instructions 对照。
- 同目录同输入同 prompt 用原子启动记录防重复调用。新一轮评估换新目录。结果含完整输出、输入与 prompt 哈希、Gateway log id、token 数和字数。
- 字数和无条件词只证明形式。内容评审要核对事实与时序、主因、传导和判断，出现硬事实错误的候选不算通过。
