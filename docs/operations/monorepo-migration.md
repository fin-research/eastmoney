# Monorepo迁移记录

日期：2026-10-28。新仓为[fin-research/eastmoney](https://github.com/fin-research/eastmoney)。

## 公开内容决策

新仓采用审计后的干净源码基线，不导入旧Git对象和标签。
旧仓保留原可见性及历史，不删除本地数据。
原私有Data、Choice、Quant的全部可用引用已做历史密钥扫描。
历史扫描使用Gitleaks 8.30.1，并检查LFS指针和高风险文件路径。

| 原私仓 | 历史扫描提交 | 发现与处置 |
| --- | --- | --- |
| Data | 133 | 5项命中，均为旧Access audience公开标识 |
| Choice | 11 | 无密钥命中；SDK二进制和服务器配置排除公开 |
| Quant | 211 | 53项命中，均为源码及训练键SHA；旧公司研究CSV不公开 |

三仓未发现LFS指针。
历史Quant包含公司研究桥接和逐项研究结果文件。
这些历史对象不推送公开仓，原私仓继续保留。

当前公开候选另做Gitleaks扫描及逐项分类。
默认规则的55项命中为3项Auth0公开SPA client ID和52项内容哈希。
规则仅对Quant路径内9个已审核的具体哈希值及公开SPA标识作例外，复扫无命中。
根CI继续运行Gitleaks和独立文件政策检查。
私有原始扫描记录只在本地 `var/`，不上传公开仓。

Choice以下文件不进入公开Git：

- `vendor/linux-x64/libEMQuantAPIx64.so`
- `vendor/linux-x64/ServerList.json.e`

它们保留在旧私有Choice仓。
私有打包工作流读取固定SDK版本，并构建已验证的monorepo提交。
原私有GHCR镜像地址和office拉取方式保持一致。

## 导入来源

| 项目 | 原仓 | main基线 |
| --- | --- | --- |
| Gateway | fin-research/gateway | `70b77c8f04fa3a086d396a1551dcf024ea0e0678` |
| Dashboard | fin-research/dashboard | `02ca2c9022d0a58c86c23b8803a94166d797b5a0` |
| Data | fin-research/data | `e048ba88f6157792477e1c2b864454edaa22d84d` |
| Choice | fin-research/choice | `d9b2df8117c08fdcd924d39d46cb0251c7e2329f` |
| Messenger | fin-research/messenger | `4ba4fb50419f7b8f02f3931270b02ccd7eaf6d9d` |
| Ingest | fin-research/ingest | `09063aa4a0dce723d6cb694ff9d7a4a215ee4af0` |
| Quant | hasbai/quant | `ac5a5bf1b6390fee97fdb61a203fbf064a470d2c` |

导入后的工程变化包括共享路径、根CI、凭据加载和Git根路径解析。
未改变业务migration文件及运行资源身份。

## Quant分支整理

原main包含现行债券训练、研究、推理和报告代码。
原master只有两个孤立初始化提交。
master使用ccxt/backtrader执行加密货币EMA/RSI/ATR回测。
它不是main的待合并债券功能，也不是当前生产模型来源。

已把旧Quant仓默认分支从master改为main，并回读远端HEAD确认。
master保留为私有历史，不强行合并，也不导入新仓。

## 本地研究

新仓使用普通checkout，根目录内七项目平级。
不创建新worktree，不移动或删除已有研究工作树。
本地 `quant/outputs`、`.Codex` 和环境可复用原目录。
这些入口均被Git忽略，原始数据和模型仍只在本地。
旧路径记录仅供历史证据追溯，不作为新研究的工作目录要求。

Git源码读取已区分monorepo根与Quant项目根。
研究报告的审阅记录说明工程迁移，不改变原报告结论。
迁移没有训练新模型、激活候选或变更模型发布资格。

## 初次切换的来源与版本

集成提交为 `f742b68ac0de60ec17df94d47ac1eb70610b198e`。
[PR1](https://github.com/fin-research/eastmoney/pull/1)通过合并队列合入main。
[完整CI](https://github.com/fin-research/eastmoney/actions/runs/40646356371)在同一SHA成功。
公开仓规则要求PR、串行合并队列和GitHub Actions的 `Monorepo CI`，没有bypass。
规则源为[main-ruleset.json](../../.github/main-ruleset.json)。

五个旧生产构建触发器已停止，新触发器仅跟踪eastmoney/main。
根目录分别为对应项目，watch paths为对应 `项目/*`。
首次构建由Cloudflare从已验证的Git提交执行，不在本机直接发布Ingest。
以下版本均已回读为100%流量，Build映射的仓库为eastmoney、SHA为上述集成提交。

| Worker | 流量版本 |
| --- | --- |
| Gateway | `60b6327a-b915-4af7-b2b2-e8fcc2258136` |
| Dashboard | `8d39f2d0-c03a-435b-8a45-c763ba0893c9` |
| Data | `dfca7b1f-d392-453c-8cde-b801e3d88b1c` |
| Ingest | `4a27becf-a53c-4efa-9f35-35ba8d54e2fb` |
| Messenger | `c03ac73f-0bde-47f1-bd22-25d8bf75679d` |

Choice私有打包工作流已在旧仓 `e8081c00b4591ff81e78df0c733a7104f61e3586` 生效。
[打包运行](https://github.com/fin-research/choice/actions/runs/40647394358)验证main及同SHA的CI成功后构建。
`latest` 与 `sha-f742b68ac0de60ec17df94d47ac1eb70610b198e` 均指向：
`sha256:e032714a56fbcc3553df04f1f16cdeb874ac5f6b9ecabe769b0ffabb85bb5ad2`。
office当前运行该digest及源码标签，health为 `choice.rpc.v1`。
原WUD标签、host网络和受限env file保持不变。

Quant没有Git自动触发器，本次未发布推理模型或研究报告。
旧Quant checkout中另有未提交模型研究修改，未混入公开基线。
原文件和已有worktree保持原位；新checkout中的本地研究产物入口仍可访问。

旧仓保留历史及未完任务，暂不归档。旧源码Actions尚未关闭，旧生产触发器已停止；Choice继续承担私有SDK打包。

## 验证与切换状态

下表记录初次基线检查与切换，恢复验证另列于末节。
只覆盖本次实际执行范围。

| 范围 | 本次执行记录 |
| --- | --- |
| Gateway | 类型生成、类型检查、127项测试与dry-run通过 |
| Data | 类型/OpenAPI生成、类型检查、338项测试与dry-run通过 |
| Messenger | 类型生成、检查、测试与dry-run通过 |
| Ingest | 类型检查、149项测试与dry-run通过 |
| Dashboard | f742初次检查、747项测试、构建、覆盖率和固定Linux视觉CI通过；随后覆盖并发版本；恢复后完整队列CI及正式Git部署通过 |
| 跨服务 | Gateway真实处理器集成与统一MCP集成通过，上游使用测试夹具 |
| Choice | CMake、编译、2项CTest及CI的amd64镜像验证通过 |
| Quant | 372项Python测试（1项原有跳过）、70项Node测试、Lint、编译、报告检查和dry-run通过；本迁移未发布线上模型 |
| 公开仓CI | 已启用，合并队列完整CI通过 |
| Cloudflare构建来源 | 五个Worker初次构建成功并核对100%流量；Dashboard恢复后的正式Git版本已回读 |
| Choice私有打包来源 | 已切换、发布新digest并核对office运行状态 |

本迁移未执行数据库migration或回填，也未重建Cloudflare资源及既有Workflow。

额外执行旧 `dashboard pnpm verify:routes` 时，旧融资脚本仍预期匿名页面303跳转。
当前Gateway采用匿名页面壳，实际返回200，该旧脚本失败。
现行Gateway真实处理器80项集成与统一MCP集成通过。
此历史脚本差异不作为已通过项目记录，后续须按现行认证契约维护。

发布后8项匿名HTTP检查通过：公开页面、Data health、保护API拒绝、旧MCP入口410及私有后端origin404。
真实测试账号程序化登录后，92项HTTP探针均通过。
MCP初始化、39项工具目录、只读市场查询及无效Choice参数拒绝均正常。
原脚本因仍预期38项工具而退出1，现更正为与实际目录及集成测试一致的39项；未重复登录。

临时edge smoke确认DM/Choice/CAMEL三条VPC链路连通。
DM未带Cookie的业务路径返回401，Choice health与CAMEL登录页返回200。
这些检查证明网络与协议连通，不代表执行Choice取数或CAMEL业务写入。
临时Worker已删除。首次smoke上传的根API token缺少VPC权限，改用本机已有Wrangler会话成功，未新建授权。

调度回读确认仅Messenger保留每分钟Cron，其余五Worker均无Cron。
未测试真实消息外发，未重训或重新激活模型。

首次完整CI曾因数据忽略规则误排除 `quant/data/更新业务数据.py` 而失败。
该8行兼容入口已按原main逐字恢复；干净源码报告校验和后续完整CI通过。

## 并发发布冲突与恢复

本节时间均为UTC，北京时间加8小时。

初次切换期间，另一任务的旧Dashboard PR127在07:00:34Z合并到 `08c204dfff2bdccbcb7705a64679c31791b60fc5`。
旧构建 `78aba9d1-a31c-454f-94fa-dac58aab524d` 于07:00:35Z启动。
删除旧触发器时，该构建在07:02:05Z被取消；此前无在途构建的检查已过时。

另一任务在07:03:02Z手动发布schema5适配版本 `a6058e93-6a1a-446f-ba30-14697ed3e4d5`。
本迁移固定的旧基线随后在07:05:29Z部署，覆盖该适配，融资模型页重新读取旧coupon暂停状态。
这是迁移基线与并发发布冲突，本迁移没有发布Quant模型。

已停止本迁移的Dashboard/Quant发布，确认没有本迁移遗留的在途构建。
用户已授权向“重构融资择时模型”聊天交接，由该任务独占恢复发布。
共享checkout出现其未提交业务文件后，本迁移停止操作共享Git状态。
迁移收尾只在忽略目录内普通clone进行，不混入其业务修改，不创建worktree。

恢复负责人于08:06:10Z将100%流量切回已验证版本 `a6058e93-6a1a-446f-ba30-14697ed3e4d5`。
部署为 `514f8e48-7c36-4511-a3c2-1d354aadd748`，已独立回读确认。

08:08:14Z的真实账号HTTP验收确认默认、指定今日运行及带新参数的接口均返回 `timing-advice-v1`。
模型版本为 `778e5cd2116288b99576`，日期2026-10-28，建议为“等待”。
页面、页面数据及业务指标接口均返回200，匿名业务API返回401。
本迁移读取验收记录核对结果，未重复登录。

恢复任务另已发布Quant三档推理与最终报告。
其100%流量版本为 `230fb2e6-0eb5-4689-b10f-362ed50b8f6f`。
恢复任务核对推理模块与真实成功Workflow一致，报告HTTP及内容哈希与当前README一致。
这些属于融资择时恢复任务，本迁移未发布Quant。

[恢复PR2](https://github.com/fin-research/eastmoney/pull/2)已通过[完整合并队列CI](https://github.com/fin-research/eastmoney/actions/runs/40656456459)，包括视觉回归。
合入main的提交为 `fc4907b9e0a03d5b0d2982437158e78c27c73b66`。
此前依赖和Node头文件下载失败的运行仍保留。
修复复用依赖缓存与固定镜像内匹配的头文件，没有关闭检查。

正式Cloudflare构建 `00e83e00-dc4c-43b4-942a-f8e9c803ced7` 成功。
来源为eastmoney/main的上述提交，根目录为 `/dashboard`。
08:33:41Z部署版本 `dc505af1-5587-48b8-b79a-9be59bfb745e` 承接100%流量，替代临时回退版本。
本迁移已独立回读实际流量版本。

08:35:52Z再次执行程序化验收，默认、指定今日运行及带新参数的接口均返回同一条active三档结果。
日期2026-10-28、行情截至10月27日、建议“等待”，三概率与归档Workflow一致。
页面、页面数据、决策和业务指标返回200，匿名业务API返回401。
报告GET/HEAD及正文与最终README一致性已在部署后重新核对。
本迁移读取这些验收记录核对结果。

恢复任务已交回共享checkout写入权。
迁移收尾基于上述最新main，仅集成独立clone内的8个任务文件。
