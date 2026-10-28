# CAMEL 资金系统

Data 通过 `CAMEL` VPC binding 调用资金系统。浏览器直接调用同源 `/data/camel/*`，经 Gateway 精确校验拆借读/导入权限和 POST 同源后，由 `GatewayData` 按专用 CAMEL 准入结果分派，不经过 Dashboard 业务后端。`InternalData` 仍供可信机器绑定调用。默认入口固定 404，CAMEL 不加入通用公开资源、GraphQL 或 MCP 目录。

## API

浏览器前缀 `/data/camel`，内部绑定前缀 `/camel`。GET/HEAD 要求 `research.interbank:read`，POST 要求 `research.interbank:import`。成功返回业务对象，错误沿用 Data 的 `detail/error.code`，响应 `no-store`。

| 方法和路径 | 请求 | 返回 |
| --- | --- | --- |
| `GET /borrowings` | `date=YYYY-MM-DD&current=1&size=50`，size 上限 100 | `{records,total}` |
| `POST /borrowings/parse` | 原始 xlsx 文件体，上限 10MB | `{status,data,totalNum}` |
| `POST /borrowings/import` | `{records:[…]}`，上限 200 笔，同一成交日 | `{saved:true}` |
| `POST /attachments` | 原始 PDF 文件体，上限 10MB | `{id}` |
| `POST /repayment-drafts` | `{date,serialNo,attachmentIds}` | `{hid}` |
| `GET /repayment-drafts/:hid` | 划拨单号 | 草稿关联、附件 ID 和状态 |

文件请求使用对应 MIME 的 `Content-Type` 和 `X-Filename: encodeURIComponent(文件名)`，
Data 校验后流式封装为单文件 multipart 转发；禁止路径和其他文件类型。

字段事实来源为 [contracts.ts](../../src/camel/contracts.ts)。2026-10-19 经真实 VPC 解析读取字段名，
保留了原解析器的合同号、交易员、银行及支行、结算天数和方向字段；不保存业务样本到仓库。Data 的解析响应仅保留已定义字段；投影前校验上游 warnings 和逐行警告，存在警告即停止，利息红字舍入标记除外。
浏览器用原 Excel 的金额、利率、日期、账号及天数覆盖解析值，再提交导入。
`days` 为实际占款天数，`daysPurpose` 为拆借期限。Data 不解析压缩包、不保存业务文件。

导入前按成交日完整分页查重，再检查额度和保存记录数组。存在相同编号则返回 409，
调用方重新读取台账并筛选待导入记录。草稿保存只接受日期、交易编号及附件 ID，
服务端完整分页取得唯一台账，并从系统读取申请部门、付款账户、金额与收款账户。
已有 hid 返回 409，不重复建单。无提交、审批或支付端点。

调用方在每次副作用前持久保存 intent，成功后保存台账 ID、附件 ID、hid。
网络失败、解码失败和写入结果不明均不自动重发。恢复时查询台账及已有草稿；
附件上传结果不明且没有 ID 时必须停止。草稿保存后由调用方读取一次详情，
确认 hid、交易关联、附件 ID 以及 reviewStatus/status 均为 0。

## 会话

复用 [client.ts](../../src/camel/client.ts) 的 Cache API 会话和 AI 验证码识别。
用户名、原始密码及 AI Gateway token 只从 Worker Secret 读取。密码按网页协议
RSA PKCS#1 v1.5 加密。会话缓存 `camel-session-v1` 只保存 accessToken、tokenName、
deviceId 和服务端 JWT `iat + timeout` 派生的 expiresAt，到期前五分钟刷新。
Cache API 仅在当前 PoP 生效，跨节点首次访问可能分别登录。

业务协议适配 GET、multipart、原始数组与带 header 的 JSON，不接受调用方上游 URL。
JSON 业务请求只有明确会话失效码允许重新登录后重试一次；业务错误文字中的“过期”不触发重放。
Excel/PDF multipart 通过有大小上限的流转发，不在 Worker 中整包缓存。已消费文件流不重发；
会话拒绝时保留调用方进度并停止。
验证码单次使用，识别失败获取新图。AI 传输统一经 [共享 AI](../../../docs/AI.md)。

## 验证

[camel.test.ts](../../tests/camel.test.ts) 保护登录与会话；
[camel-runtime.test.ts](../../tests/camel-runtime.test.ts) 在真实 workerd 验证 RSA DER 加密；
[camel-business.test.ts](../../tests/camel-business.test.ts) 保护协议、私有边界、分页查重、
草稿构造、已有草稿与结果不明时不重发。真实写操作由用户选择或拖入成交 ZIP 后的浏览器流程执行；先完成本地保存，再导入。
部署、VPC 和 CPU 验证按 [开发文档](../DEVELOPMENT.md) 与 [CPU 预算](../CPU_BUDGET.md)。
