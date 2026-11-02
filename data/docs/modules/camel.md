# CAMEL 资金系统

Data 通过 `CAMEL` VPC binding 调用资金系统。浏览器直接调用同源 `/data/camel/*`，Gateway 校验拆借读/导入权限和 POST 同源后，由 `GatewayData` 按 CAMEL 准入结果分派，不经 Dashboard 后端。`InternalData` 供可信机器绑定调用。CAMEL 不进入通用公开资源、GraphQL 或 MCP 目录。

## API

浏览器前缀 `/data/camel`，内部绑定前缀 `/camel`。GET/HEAD 要求 `research.interbank:read`，POST 要求 `research.interbank:import`。成功返回业务对象，错误沿用 Data 的 `detail`/`error.code`，响应 `no-store`。

| 方法和路径 | 请求 | 返回 |
| --- | --- | --- |
| `GET /borrowings` | `date=YYYY-MM-DD&current=1&size=50`，size 上限 100 | `{records,total}` |
| `POST /borrowings/parse` | 原始 xlsx 文件体，上限 10MB | `{status,data,totalNum}` |
| `POST /borrowings/import` | `{records:[…]}`，上限 200 笔，同一成交日 | `{saved:true}` |
| `POST /attachments` | 原始 PDF 文件体，上限 10MB | `{id}` |
| `POST /repayment-drafts` | `{date,serialNo,attachmentIds}` | `{hid}` |
| `GET /repayment-drafts/:hid` | 划拨单号 | 草稿关联、附件 ID 和状态 |

文件请求用对应 MIME 的 `Content-Type` 和 `X-Filename: encodeURIComponent(文件名)`。Data 校验后流式封装为单文件 multipart 转发，只接受 xlsx 和 PDF。Data 不解析压缩包，不保存业务文件。

字段事实来源为 [contracts.ts](../../src/camel/contracts.ts)。解析响应只保留已定义字段，包括合同号、交易员、银行及支行、结算天数和方向。投影前校验上游 warnings 和逐行警告，有警告即停止，利息红字舍入标记除外。

浏览器用原 Excel 的金额、利率、日期、账号和天数覆盖解析值，再提交导入。`days` 为实际占款天数，`daysPurpose` 为拆借期限。

## 写入语义

- 导入前按成交日完整分页查重，再检查额度并保存记录数组。存在相同编号时返回 409，调用方重新读取台账并筛选待导入记录。
- 草稿保存只接受日期、交易编号和附件 ID。服务端完整分页取得唯一台账，从系统读取申请部门、付款账户、金额和收款账户。已有 hid 返回 409。
- 没有提交、审批和支付端点。
- 调用方在每次副作用前持久保存 intent，成功后保存台账 ID、附件 ID 和 hid。
- 网络失败、解码失败和写入结果不明时不自动重发。恢复时查询台账和已有草稿。附件上传结果不明且没有 ID 时必须停止。
- 草稿保存后，调用方读取一次详情，确认 hid、交易关联、附件 ID，以及 `reviewStatus`、`status` 均为 0。

## 会话

会话由 [client.ts](../../src/camel/client.ts) 管理：Cache API 缓存会话，AI 识别验证码。用户名、密码和 AI Gateway token 只从 Worker Secret 读取。密码按网页协议做 RSA PKCS#1 v1.5 加密。

- 缓存 `camel-session-v1` 只存 `accessToken`、`tokenName`、`deviceId` 和由服务端 JWT `iat + timeout` 推导的 `expiresAt`，到期前五分钟刷新。
- Cache API 只在当前 PoP 生效，跨节点首次访问可能分别登录。
- 业务协议适配 GET、multipart、原始数组和带 header 的 JSON，调用方不能指定上游 URL。
- 只有明确的会话失效码允许重新登录并重试一次。业务错误文字中的“过期”不触发重放。
- Excel 和 PDF 的 multipart 经有大小上限的流转发，不在 Worker 中整包缓存。已消费的文件流不重发。会话被拒时保留调用方进度并停止。
- 验证码单次有效，识别失败就获取新图。AI 传输见[共享 AI](../../../docs/AI.md)。

## 验证

- [camel.test.ts](../../tests/camel.test.ts)：登录与会话。
- [camel-runtime.test.ts](../../tests/camel-runtime.test.ts)：在真实 workerd 验证 RSA DER 加密。
- [camel-business.test.ts](../../tests/camel-business.test.ts)：协议、私有边界、分页查重、草稿构造，以及已有草稿和结果不明时不重发。

部署、VPC 和 CPU 验证见 [DEVELOPMENT](../DEVELOPMENT.md) 与 [CPU 预算](../CPU_BUDGET.md)。
