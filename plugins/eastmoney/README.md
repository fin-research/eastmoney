# eastmoney 插件

- MCP：`eastmoney`（https://eastmoney.hasbai.xyz/mcp，OAuth，首次使用运行 `/mcp` 授权）
- 技能：market-commentary（含今日聚焦）、secondary-pool-weekly、research-commentary、interbank-ledger（拆借台账：ZIP 归档、资金系统导入与草稿、流程截图）、credit-weekly（授信周报：归档、导出授信一览表、周报转数值并入累计簿、导出两页 PDF）
- 依赖：Node.js 20+（报告脚本）；interbank-ledger 另需 macOS、Playwright 和办公网络，凭据见其 SKILL.md；credit-weekly 另需 macOS 和 Xcode 命令行工具（swiftc，用于绘制 PDF）
- 安装：`/plugin install eastmoney --marketplace fin-research/eastmoney`
