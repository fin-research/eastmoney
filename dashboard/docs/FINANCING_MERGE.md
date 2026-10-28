# 融资工作台合并评估与交付

本文为历史交付记录。当前融资与二级池导入已改为本地解析、线上直接写入，旧导入 Workflow 和切换脚本均已退役。当前发布请使用 `docs/DEVELOPMENT.md`。

评估日期：2026-09-08。基线为 Dashboard `05e9751`，融资来源为 `4045063`。交付前已集成同期 main 的 `f5acffa` AI 配置修复并复跑完整验证。

## 结论

合并可行，运行用量预计无明显增加。两个项目使用同一 Svelte 技术栈、Access audience、Hyperdrive 和 Neon 数据库。合并共享路由、组件和构建，不复制业务数据，不改变请求对应的业务查询或定时执行频率。代价是 Worker 包体与构建时间增加，两个领域共享发布故障范围。

## 可复核的性能证据

两份代码分别使用锁文件在独立工作树构建，前端统计包含当前路由布局、页面及其静态依赖，不追踪尚未执行的 dynamic import。gzip 为逐文件压缩总和，不是浏览器实测传输量。

| 当前页面 | 合并前 gzip | 合并后 gzip | 增量 |
|---|---:|---:|---:|
| 门户 `/` | 46.22 KiB | 50.43 KiB | 4.21 KiB |
| 市场点评 `/market-briefing` | 340.90 KiB | 346.52 KiB | 5.62 KiB |

门户静态依赖请求数保持 17。市场点评由 25 个变为 27 个。融资重型解析器仍在浏览器 Web Worker，负债周报动作客户端按需加载。普通研究路由不执行融资身份、提醒或 SQL 查询。融资导航沿用 SvelteKit 服务端认证与布局复用，不新增客户端会话探测请求。

最终 Wrangler dry-run：Worker 未压缩体积约 6.05 → 7.06 MiB，gzip 约 1.23 → 1.45 MiB。本机 startup profile 的 active CPU 约 66.5 → 56.0 ms，这种单次本地采样只能说明未见明显启动退化，不能据此宣称线上加速。正式线上 startup 指标及版本在部署时回读。

Cloudflare 当前文档列出的 Worker 上限为未压缩 64 MiB、全局初始化 1 秒。最终部署检查仍以实际平台校验为准。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

## Cloudflare 用量

- Worker 请求和 CPU 时间按实际使用计费。合并页面与组件数量不会单独增加费用。静态 Assets 请求免费，数据库网络等待不计 CPU。Standard 超出包含量后，每百万请求 $0.30、每百万 CPU 毫秒 $0.02。

  例如每月 100 万次请求若平均额外增加 1ms CPU，在已超额情况下对应约 $0.02。此为敏感度示例，不是实际账单预测。[Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/)
- Hyperdrive、Neon SQL、D1、R2、AI 请求保持原数据流。同一个 R2 bucket 的额外绑定不会复制对象。合并不增加模型自动调用、全量报表加载或轮询频率。
- 每小时融资提醒与每日经济数据同步按 cron 表达式分流，停用旧 Worker cron，避免重复扫描。导入沿用 `financing-debt-import` Workflow 与原子事务，没有创建第二条生产导入链路。
- 一次统一构建会更大。停止向历史融资仓库交付日常功能后，不再为相同共享组件执行两份发布。尚未核对账户完整历史账单，不能声称账单已下降。[Builds 计费](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

## 行为与安全

`/financing` 保持融资入口。人员与角色权限转入 `/management/people`。融资人员资料转入 `/management/financing-profile`，登录邮箱、密码和偏好统一由 `/profile` 维护。两个旧路径使用保留 POST body 的 307 重定向。

融资身份与全站身份统一，原人员关联、角色权限、RLS、本人任务边界、单请求单连接和增量保存均保留。Auth0 管理凭据使用统一 `AUTH0_MANAGEMENT_CLIENT_SECRET`。融资人员和权限属于中央身份上的业务授权，不再独立认证。

`date` 保留业务自然日。无 offset 的源 timestamp 以 UTC+8 解释，有 offset 的 timestamp 保留实际时刻和微秒精度，页面固定上海时区。禁止修改全局 pg 类型解析器，也不批量改写既有生产时间戳。

## 发布顺序与回退

1. 完成 Dashboard 全套验证、构建后路由检查及旧仓库历史验证。
2. `node --use-env-proxy scripts/provision-auth0-management.mjs --apply` 复用已有完整权限的 M2M 凭据，通过 Worker version 原子切换统一 Client ID 与 Secret。旧专用 Secret 在新版本生效后移除。
3. `node --use-env-proxy scripts/cutover-financing.mjs` 只读检查路由、cron、Workflow 与活跃导入。无活跃导入后，`--stop-old-cron` 停止旧小时任务。
4. 将通过验证的 Dashboard 推入 main 并部署。确认 Workflow 归属与两个 cron。随后 `--switch-route` 删除旧 `/financing/*` 分流，让该路径由 Dashboard 主路由承接。
5. 历史融资配置保持空 routes、空 cron、关闭 workers.dev 与 preview URLs，Workflow binding 指向 Dashboard。提交该归档配置，防止旧构建重新取得业务所有权。保留原源码、Git 历史、原始文件和数据库。

若切换失败，先保留旧路由。若需要完整回退，恢复旧 Worker 的融资 route 与小时 cron，并将同名 Workflow 指回旧 Worker，然后停用 Dashboard 的小时 cron。操作前确认没有活跃导入。不得在两个 Worker 同时运行提醒或改写生产 schema。

## 验证范围

Dashboard 371 项单元及契约测试。构建后 19 项个人信息路由检查、28 项融资与管理路由检查。后者使用本地 PGlite 执行全部融资 migration 和实际 SQL、模拟签名 JWKS/Auth0/R2，覆盖页面读取、旧路径跳转、未登录/未关联/无权限/跨源拒绝，以及真实 action 创建项目和读取详情、版本化头像的私有缓存。15 个已开启连接均关闭，单请求峰值为 1。融资 Cron 保留原调度失败重试语义。

旧仓库 99 项测试、Svelte 检查通过。未执行真实邮件发送、生产 Excel 写入、浏览器手工操作或截图验收。此次合并不需要生产数据库 migration。公共规范和模块文档分流见 [模块分流](../AGENTS.md#context-routing)。

## 身份与凭据统一后的补充验证

中央 Access JWT 只验证一次，融资模块只加载人员与授权。统一凭据不修改现有人员 ID、Auth0 用户角色、RLS 或数据库结构。补充回归验证同一 Auth0 subject 进入 RLS、事务身份在提交后清除、未分配给自己的任务更新被拒绝，以及个人资料与融资管理均使用唯一管理 Secret。
