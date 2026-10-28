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
规则仅对Quant路径内已审核的具体哈希值及公开SPA标识作例外，复扫无命中。
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

## 验证与切换状态

本节随实际执行结果更新。未完成项目不视为验收通过。

| 范围 | 当前结果 |
| --- | --- |
| Gateway | 类型生成、类型检查、127项测试与dry-run通过 |
| Data | 类型/OpenAPI生成、类型检查、338项测试与dry-run通过 |
| Messenger | 类型生成、检查、测试与dry-run通过 |
| Ingest | 类型检查、149项测试与dry-run通过 |
| Dashboard | 快速检查、CI工具测试、747项测试与生产构建通过；完整CI待执行 |
| 跨服务 | Gateway真实处理器集成与统一MCP集成通过，上游使用测试夹具 |
| Choice | CMake、编译及2项CTest通过；amd64镜像由CI验证 |
| Quant | 372项Python测试（1项原有跳过）、70项Node测试、Lint、编译、报告检查和dry-run通过；线上模型未发布 |
| 公开仓CI | 尚未启用 |
| Cloudflare构建来源 | 尚未切换 |
| Choice私有打包来源 | 已准备工作流，尚未切换 |

数据库未迁移、未回填；Cloudflare资源和既有Workflow未重建。

额外执行旧 `dashboard pnpm verify:routes` 时，旧融资脚本仍预期匿名页面303跳转。
当前Gateway采用匿名页面壳，实际返回200，该旧脚本失败。
现行Gateway真实处理器80项集成与统一MCP集成通过。
此历史脚本差异不作为已通过项目记录，后续须按现行认证契约维护。
