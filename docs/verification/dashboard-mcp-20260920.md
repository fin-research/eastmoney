# Dashboard MCP 上线验收（2026-09-20）

Dashboard 业务 MCP 已上线，统一入口仍为 https://mcp.hasbai.xyz/mcp，上游为 https://eastmoney.hasbai.xyz/api/mcp，Cloudflare server ID 为 `dashboard`。逐用户 Auth0 OAuth，`on_behalf=true`。

## 已确认

- Dashboard PR https://github.com/fin-research/dashboard/pull/37，任务提交 `e956fbce48417d1c3608443c443edb158e47b188`，合并组 `425d6aa177d2dca5d957694c6f3ab50468284430`。
- 合并队列完整 Dashboard CI https://github.com/fin-research/dashboard/actions/runs/35515531883 成功：单元/覆盖率、类型、构建、视觉回归。Cloudflare 构建 `d04b7aa4-7717-4fd1-a2b7-f0bd6c8582b9` 成功，2026-09-20 14:16:27 UTC 完成。
- Gateway PR https://github.com/fin-research/gateway/pull/8 与 https://github.com/fin-research/gateway/pull/9 合并。最后合并 `0dcb6844736b00395a994724b43e9ababa2cf04b`，Cloudflare 构建 `3e69377c-0cdd-4a5b-9a97-fda6e55fc542` 成功。
- 本地 Dashboard 快速检查 0 errors、8 个既有 warnings。MCP 测试 6/6。Gateway 检查 82/82、部署 dry-run 成功。
- 实际 Gateway + 构建 SvelteKit + 外部内存夹具验证：目录、页面读取、进度写入回读、原 named action 校验、权限撤销均成功。可通过 Dashboard `scripts/verify-mcp-integration.mjs` 重现。
- 真实 `test@18.cn` 程序化登录。未使用浏览器、机器身份替代或共享用户 JWT。
- 主站 MCP 70 工具，其中 37 个修改/生成工具。真实读取资金日报列表、交易进度、融资项目、授信报表、融资模型、热点成功。
- Cloudflare managed OAuth 通过，Dashboard / Data / research 三个上游均 Connected。统一门户返回 98 工具：Dashboard 70、Data 24、research 1、Portal 管理 3。
- 经 Portal 实际调用 Dashboard health、融资项目读取、无效修改输入拒绝、交易进度同值写入和回读成功。只更新测试账号，业务状态值前后一致。
- 经 Portal 实际调用 `dashboard_generate_market_focus`，报告日 2026-09-18，返回完整 stock/bond 结果。没有覆盖既有定稿。
- Dashboard 后台目录为 `ready`，70 工具，`last_successful_sync=2026-09-20 14:18:48 UTC`。
- Portal 配置保留 Data/research、原登录策略及 capability overrides。当次验收使用的临时 Cloudflare 凭据已撤销。

## 验证边界与发现

未逐一执行全部业务修改、删除和 AI 工具。代表性写入/生成验证不能等同于每个工具的独立业务验收。文件上传与二进制附件仍沿用网站。

首次今日聚焦调用遇到 Data/DM 新闻接口 TLS handshake timeout。随后同一数据接口返回 200，主站及 Portal 两条 AI 路径均成功。这是已观测的上游瞬时故障，不是 MCP 协议失败。

原有 Data MCP 后台目录仍保留 23 工具的旧缓存，时间为 2026-09-09。真实用户通过 Portal 列出 24 工具且 health 成功。测试账号重新授权后后台计数未刷新，因此 Gateway 通用 `--check-catalog` 仍因 Data 旧缓存报失败。本次 Dashboard 目录单独回读为 Ready/70 并与实际一致，未为消除旧 Data 告警关闭检查或改用共享用户凭据。
