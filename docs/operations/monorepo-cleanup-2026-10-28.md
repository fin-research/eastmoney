# 本地清理与依赖统一

清理日期：2026-10-28。验收收尾：2026-10-29。接续[首次迁移与恢复](monorepo-migration.md)。

## 本地目录与远程归档

当前源码入口为 `/Users/yueshi/src/eastmoney/eastmoney`。
六个旧主checkout和88个关联worktree已删除。
删除前逐个复核HEAD、未提交状态和二进制补丁，确认与恢复清单一致。

| 原远程仓库 | 状态 |
| --- | --- |
| `fin-research/gateway` | 已归档，保留公开历史 |
| `fin-research/dashboard` | 已归档，保留公开历史 |
| `fin-research/data` | 已归档，保留私有历史 |
| `fin-research/messenger` | 已归档，保留公开历史 |
| `fin-research/ingest` | 已归档，保留公开历史 |
| `hasbai/quant` | 已归档，保留私有历史 |
| `fin-research/choice` | 保留私有活动仓库，继续打包SDK |

Choice旧主目录及 `choice-request-trace-20261026` 保留。
当前生产代码已整合到monorepo。
历史未合入实验仅作私有留存，不代表全部合入main。

本地恢复入口为 `var/monorepo-cleanup-20261028/`，整个目录均被Git忽略。
其中包括：

- `history/*.bundle`：六仓全部引用及94个checkout的HEAD，已通过bundle校验。
- `local-files/`：未提交补丁、原始资料、审计记录和验收证据。
- `path-map.json`：旧路径、HEAD、bundle和文件备份的对应关系。
- `migration-bundles/`：迁移临时clone的恢复包，原14处clone已删除。
- 各类manifest：文件路径、字节数和SHA-256，用于恢复核对。

额外保留了34个checkout中的截图、测试trace及覆盖率记录。
18个checkout中的 `.wrangler` 内容也已完整保存。
本地D1/R2状态与人工修复脚本均包含在内。
恢复归档可能包含凭证和原始数据，不进入公开Git。

## Quant本地入口

研究统一在 `/Users/yueshi/src/eastmoney/eastmoney/quant` 执行。
`outputs/` 和 `.Codex/` 已实体迁入，逐文件SHA-256核对一致。
三个原来指向旧worktree的子目录也已实体化并核对。
清理后Quant及其Python环境均无链接指向已删路径。

本地表格、报告、SDK文档和研究输入均有保留位置。
旧主checkout中缺少的运行变量已补齐到根 `.env`。
根文件已有值未被覆盖，历史分支凭据只留在恢复归档。
Python环境已在新路径通过 `uv sync --locked` 重建。
Quant bundle已实际恢复验证，18个旧checkout的HEAD均可读取。
本次不训练模型，不修改生产模型指针或发布资格。

冻结记录中的旧绝对路径保留作历史标识。
恢复时按 `path-map.json` 找到原源码和资料，不修改旧证据哈希。
新研究可更新本地忽略数据，无需重建旧worktree。

## JavaScript依赖

六个JS项目使用根workspace、精确catalog和单一pnpm锁。
包清单继续声明各自实际依赖，版本由根catalog维护。
Node统一为24，pnpm固定为10.33.2。
Python uv锁及Choice CMake依赖保持独立。

统一的共享版本包括TypeScript 5.9.3、Node types 24.13.5、
Wrangler 4.134.0、Vitest及coverage 4.1.11、Hono 4.13.8。
Workers测试池统一为0.22.0。
依赖一致性检查同时验证包声明、catalog和根锁。
Quant来源身份保守覆盖整个根锁和具体vendor包。
任一服务更新依赖后，都需审阅Quant报告的来源记录。
该审阅不自动修改最终研究报告，也不视为新模型发布。

Cloudflare五个构建触发器已改为仓库根执行。
构建先用根锁安装目标项目及根工具依赖，再进入项目目录发布。
Dashboard额外执行自身build。

监听路径包含项目路径、根package、workspace、锁文件和vendor。
构建变量固定Node/pnpm，并关闭自动安装，避免重复解析依赖。
Wrangler非业务遥测已关闭，避免额外网络等待。
该配置使用[官方自定义依赖安装机制](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/#skip-dependency-install)。

本地检查已通过：Dashboard 750项测试及23项CI工具测试；
Gateway 127、Data 338、Messenger 85、Ingest 149项测试；
Quant在线75项测试，Python 376项测试（1项原有跳过）。
真实handler集成80项、MCP 39工具、Worker dry-run及公开安全检查通过。

首轮完整队列的固定Linux视觉与覆盖率已成功。
Data安装下载停滞后超时，根门禁拒绝该次合并，失败记录保留。

第二轮跨服务安装确认SheetJS官方CDN连续返回503。
按[官方建议](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring)，
根vendor保存同一xlsx 0.20.3安装包，并核对原锁中的SHA-512。
catalog固定版本，根override统一选择本地包。
CI在安装前检查该包哈希与精确白名单。
Quant本地登记也检查该包来源及未提交修改。
仅改变包来源，不改变版本或内容。

干净目录的Data离线安装及Dashboard解析探针已通过。
[PR4](https://github.com/fin-research/eastmoney/pull/4)已通过
[完整合并队列CI](https://github.com/fin-research/eastmoney/actions/runs/40676995351)。
包括七项目、跨服务集成、覆盖率和固定Linux视觉回归。
合入main的提交为 `faf7c0fce69a73df4cb44c0e5d9ec4e7d39942fa`。

五个Cloudflare构建均成功，来源为该提交及eastmoney/main。
已回读以下100%流量版本：

| Worker | 版本 |
| --- | --- |
| Gateway | `bff23bb4-11e5-4719-ae43-a05ced05072f` |
| Dashboard | `8da1b42b-f23a-41fa-b8ca-2898682ba503` |
| Data | `efb14ebb-b6fd-48d6-972c-70d720b5e666` |
| Ingest | `d0869332-2ac6-41d9-9366-46f8ffa35731` |
| Messenger | `decf749f-2f54-4126-9039-4fef9b055108` |

Quant仍为 `230fb2e6-0eb5-4689-b10f-362ed50b8f6f`，本次未部署。
上线后9项匿名HTTP检查、7项登录后只读检查均通过。
三档模型身份、研究报告SHA及39项MCP工具目录一致。
业务指标探针初次漏传必需run参数，按真实运行ID修正后通过。
验收未调用Choice取数、未生成AI内容，也未写业务数据。
