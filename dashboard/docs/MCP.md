# Dashboard MCP

客户端连接 Gateway 统一入口 `https://eastmoney.hasbai.xyz/mcp`，工具名无 `dashboard_` 前缀。授权、客户端准入和聚合机制见 [Gateway MCP](../../gateway/docs/MCP.md)，认证边界见 [共享 AUTH](../../docs/AUTH.md#mcp-边界)。

## 连接

- 协议：Streamable HTTP。认证：Auth0 OAuth 授权码 + PKCE，ID token 不可用。
- Gateway 在 `/mcp` 准入 CIMD 客户端（ChatGPT、Codex、Claude、OpenCode 等，动态注册），客户端无需填写 client ID 或 secret。MCP token 不能访问普通业务 REST 或 `/data/mcp`。
- ChatGPT：新建连接，填写上述 URL 并选 OAuth，高级 OAuth 设置留空。已有固定 client ID 的连接须删除重建。
- Codex：在配置中加入下列内容，再执行 `codex mcp login eastmoney`。删除旧的显式 `oauth.client_id`、`callback_port`。
- OpenCode 的配置见 [Gateway MCP](../../gateway/docs/MCP.md)。

```toml
[mcp_servers.eastmoney]
url = "https://eastmoney.hasbai.xyz/mcp"
```

客户端配置参考 [OpenAI MCP](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml)。

## 发布范围

Gateway 合并 Dashboard 的 25 个工具与 Data 的 22 个只读市场查询，共 47 项候选，实际目录按当前用户权限筛选。Data 资讯列表名为 `news_list`，Dashboard 的归档新闻详情为 `news`。旧公网 `/api/mcp` 与 `/data/mcp` 返回 410，内部路径只供命名 Service Binding 调用。

Dashboard 的 25 个工具：

- 市场研究（15）：`market_report`、`save_market_report`、`knowledge_graph`、`policies`、`research_search`、`policy_articles`、`update_policy_articles`、`article`、`news`、`commentaries`、`commentary`、`commentary_revisions`、`create_commentary`、`update_commentary`、`economic_indicators`。
- 授信与二级池（4）：`credit_report`、`bond_ledger`、`file_upload_request`、`bond_ledger_import`。
- 融资（6）：`bond_investor_reference`、`create_bond_investor`、`update_bond_investor`、`financing_clients`、`create_client`、`update_client`。

发布清单在 `src/lib/server/mcp.ts`，Gateway 侧名单在 `gateway/src/mcp.ts`，两处须一致。不发布删除、下载和 AI 生成工具，MCP 不调用另一层生成模型。站内 AI 侧栏也连接 `/mcp`，共用同一目录。

### 授信

`credit_report` 的输入为可选 `query.date`、`query.institutionId`。它固定调用 `/api/credit?view=masked`，读 `credit.masked_as_of`。机构只返回 ID，完整机构资料、客户名称和自由文本不进入结果。字段与口径见 [授信工作台](modules/credit-workbench.md#接口与维护)。

```json
{"name":"credit_report","arguments":{"query":{"date":"2026-10-26"}}}
```

### 二级池

`bond_ledger` 只读现行运营周报，受 `/api/bond-ledger` 的读取权限约束。字段、单位与公式见 [二级池](modules/secondary-bond-pool.md)。

```json
{"name":"bond_ledger","arguments":{}}
{"name":"bond_ledger","arguments":{"query":{"start":"2026-01-01","end":"2026-10-27"}}}
```

- 无日期（或 `query:{}`）只返回 `databaseDates`、`availableStartDate`、`availableEndDate`，不返回文件名或 R2 key。
- `query.start` 与 `query.end` 须同时提供，是真实日期且起始不晚于结束，不接受 `date` 下载参数和额外字段。
- 区间返回 `BondLedgerReport` 业务 DTO，逐层白名单投影，不含原始持仓、团队、投资经理和导入 / 存储审计元数据。数值沿用原 DTO，不重新计算。
- 区间无数据返回 `hasData:false` 与原空结构。`auditPassed:false` 保留对账明细，调用方不输出周报正文。
- HTTP 失败返回 MCP `isError`，含原状态与安全错误信息，不伪装为空数据。
- 上传：`file_upload_request`（`purpose="bond-ledger"`，需 `bond.ledger:import`）生成约 15 分钟有效的 R2 预签名直传地址，客户端直接 PUT 原件，再用 `bond_ledger_import` 按 `uploadId` 导入。文件字节不经 MCP。

### 点评

标准点评用 `/api/commentaries` 与 `commentary` 主数据。读取、创建、修改和历史版本的结果做字段投影，不含原稿、导入文件名、PDF 存储 key 和工作区检索元数据。修订须带 `updatedAt`，冲突返回原业务错误。

### 融资

- `bond_investor_reference` 查询目标债券、既有分配和机构目录。`create_bond_investor`、`update_bond_investor` 新增或修改单条分配。
- 分配金额单位为元。修改须带当前记录 ID 与预期金额，避免覆盖并发修改。
- `financing_clients` 读机构及别名 / version，`create_client`、`update_client` 维护机构。
- 工具按各自的 `financing.data:read/create/update` 权限分发。

## 实现与权限

- `src/routes/api/mcp/+server.ts` 用 Agents `createMcpHandler` 与 MCP SDK，每次请求创建独立 server。
- Gateway 的 `/mcp/policies` 按当前用户真实路由权限筛选目录。执行经 IDENTITY 私有 `/mcp/dispatch`，再检查权限与 token 到期时间，然后调用原业务接口。权限撤销后旧目录不能继续授权。
- 市场定稿读取沿用公开只读规则。
- 请求与响应上限各 8 MiB。业务接口的输入校验与脱敏字段白名单继续生效。

## 验证

- `node --test tests/mcp.test.mjs tests/credit-masked.test.mjs`：SDK 发现与调用、发布白名单、输入校验、脱敏 SQL / 接口和字段白名单。ID 的 Unicode 校验在服务端执行，JSON Schema 不导出需要 Unicode 标志的 `pattern`，保留长度与路径限制。
- 构建后运行 `node scripts/verify-mcp-integration.mjs`。它串联真实 Gateway、构建后的 SvelteKit 和私有授权桥接，配合 Data 处理器检查 47 项目录、参数校验和权限撤销。外部服务用内存夹具，`GATEWAY_CHECKOUT` / `DATA_CHECKOUT` 默认指向同级目录。
- 生产只读验收用 Gateway 的程序化登录，带 API Bearer 直连本端点，核对当前权限下的 47 项候选目录并执行查询。ChatGPT 最后的 private-key token exchange 由 ChatGPT 主机完成，程序化验收不能代替界面连接。

## AI Search 研究检索

`research_search` 是只读 `POST /api/research/search`，权限 `research.article:read`，每次执行经 IDENTITY 重新检查。它调用研究库 `https://research.hasbai.xyz/mcp` 的 `search`，不运行生成模型，不转发用户凭据。

```json
{"body":{"query":"查询","ai_search_options":{"retrieval":{"retrieval_type":"hybrid","max_num_results":50,"filters":{"type":{"$eq":"研报"},"published_at":{"$gte":1792598400000,"$lt":1793203200000}}}}}}
```

- `max_num_results` 固定 50。默认取最近七个上海自然日，显式日期用 Unix 毫秒硬过滤。`type` 可为研报、政策，不设置则覆盖两类。
- 保留 RAG 的 cache、custom_metadata、query_rewrite、reranking 和 retrieval 参数。
- 返回上游完整 success / result（chunks、metadata、评分、hybrid_meta），不聚合、不截断正文。
- 上游 HTTP、JSON-RPC、isError、业务失败和响应格式错误都返回工具错误。
- 请求上限 1 MiB，上游响应上限 6 MiB，超时 120 秒，并传播取消。

测试：`node --test tests/research-search.test.mjs tests/mcp.test.mjs`。
