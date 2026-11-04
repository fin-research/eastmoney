# 线上推理

## 当前三档发行建议

用户于 2026-10-28 暂停研究并授权选用 `778e5cd2116288b99576`。该包为 `timing-advice-v1`：固定 D_all_history 线性三分类，140 维原始利率路径，取概率最大的类别，不添加行情规则。训练标签截止 2025-12-31。162 个日期是内层开发检验，未通过原研究的稳定性门槛，也不是当前权重的新验证。

生产 Workflow 已完成 2026-10-28 的真实推理、归档和入库，证据在忽略目录 `outputs/timing-advice-20261028-v2/`。旧票面包 `61492e3527e1ae367475` 继续处于 `暂停/data_quality`，历史和人工内容保留。不使用人工行情规则、输出平移、目标票面修正和缺失报价填补。

Dashboard migration `0017_timing_advice.sql` 拥有三档结构化表和发布映射。三档结果不写票面、节约、发行条款或 bp 贡献。同日发布保持稳定 ID 和人工内容。

Workflow 读取 Neon 此前 90 日的资金利率和 AAA 证券公司债 3Y 节点。输入严格 T-1，用真实可用日期，保留两条报价时钟，缺报不填补。输入与结果不可变归档后才原子发布。旧 `main.py` 票面命令受票面暂停资格约束，不是本模型的入口。

```sh
# 固定参数本地真实输入核验：不训练，不更新 Choice
uv run python scripts/run_timing_advice.py outputs/timing-advice-20261028-v2 --as-of 2026-10-28
cd online
node verify-timing.mjs ../outputs/timing-advice-20261028-v2
# 先暂存新包并校验 parity，再部署运行时，最后切指针
node publish.mjs ../outputs/timing-advice-20261028-v2 --stage-only
pnpm deploy:dry
pnpm deploy
node publish.mjs ../outputs/timing-advice-20261028-v2
pnpm exec wrangler workflows trigger quant-bond-inference-trial '{"as_of_date":"2026-10-28"}' --id timing-release-20261028
```

凭据从 `.env` 加载，不打印。Python/JS 一致性不代替效果验证，Node 耗时不代替 Cloudflare 实际运行。

模型指针必须与 Worker 运行时匹配。切换前确认旧指针未变，且没有运行、排队或重试中的旧 Workflow；部署运行时后立即切指针。切换失败时，成对恢复旧运行时和旧指针。

## 有效期与重训

固定参数包有效至 2026-12-31。期间每日只重新推理，不重训。日期超出 `retrain_after` 时 Workflow 拒绝运行。跨入 2027 年前，须核验新的交易所日历并发布新参数包，不能沿用未知年份的日历。报价覆盖不到前一报价工作日、日历年份未知或模型过期，都失败关闭。

待办：

- 2026 年留出检验显示三档边界在低波动期失效（见 [README](../README.md#2026年留出检验)）。是否继续沿用该包、暂停，或改为只给波动区间的无方向输出，须由业务决定。短期延续预测见 [TIMING_NOWCAST](TIMING_NOWCAST.md)，区间或该信号上线都需要新的结果契约、Dashboard migration 和 Worker 推理，当前不在线上。
- Data 日更修复的自然完整链路和生产 CPU，仍须取得实际运行证据。
- Data 的证券身份映射按官方生效日期使用，保留原始代码、真实值、NULL 和冲突，不相加别名余额。新映射尚未接入封存的 Quant 消费者，不能据此恢复预测。

## Workflow 与调度

Worker `quant` 没有公网 route 和 workers.dev，默认 HTTP 固定返回 404。命名入口 `ResearchReport` 提供静态报告，见 [RESEARCH_REPORT](RESEARCH_REPORT.md)。`wrangler.jsonc` 不设 Cron，调度由 Messenger 集中触发。

- 触发：周一至周五 08:30（上海时间，UTC `30 0 * * MON-FRI`），Messenger 经私有 `ScheduledTasks` 调用 `startScheduledInference`。
- 交易日检查：创建 Workflow 前，按 `scheduledTime` 的上海日期查 Data `/data/trading-days`。休市则跳过；日历出错时记录 `quant_calendar_unavailable` 并停止本轮。日历故障可能漏掉当日生成，恢复后手动补发。
- 幂等：实例 ID 为 `bond-YYYY-MM-DD`，重复投递只确认实例存在。手动历史运行按原样执行。
- 输入：先固定模型 manifest，在单个只读 repeatable-read 事务里取输入，冻结到 R2。重试复用已冻结的快照。

R2 布局：

- `quant-trial/models/{version}/`：按内容固定的模型对象，最后切换 `current.json`。不能激活旧特征版本。
- `quant-trial/runs/{date}/{instanceId}/`：运行输入和结果，带 SHA-256，不可覆写。

`publish-result` 重新读取归档并校验来源，再调用 Dashboard 所有的 `financing_model.publish_online_result`。只有该步骤成功才算更新工作台。维护补发可传 `publish_result_key`，它只接受实际 Workflow 的完整归档，不接受本地伪造的结果。

### 模型资格

Dashboard migration `0016` 维护 `financing_model.model_eligibility`。生产只接受显式 `active` 的身份，缺记录、暂停或查询失败都拒绝。Workflow 在固定模型身份后、冻结输入前检查；发布函数再次锁定并检查，覆盖旧 Worker、在途结果和维护补发。本地默认预测、`--online train/infer` 和 `publish.mjs` 检查同一资格，静态报告发布不激活模型。

默认业务读取对暂停模型返回状态并清空自动预测。显式历史审计保留原值，人工结论和卖方历史保留。

### 发布顺序与验证

1. Data 采集与历史回填。
2. Dashboard migration、读取、API、页面。经 PR 和 CI 合并后自动部署。
3. Quant 一致性包与 Worker。
4. 真实 Workflow 发布与 API 核验。

验证含：Python 全部单测、编译、Ruff 和数据安全；Node 测试、类型和 dry-run；真实 Python/JS 一致性；真实数据库发布与读取；生产 Workflow 结果。回退须使用与当前运行时匹配且已核验的模型包。

Quant 保持 Cloudflare 免费套餐，不设置付费 CPU 上限（用户决策），官方限制见 [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)。未核对生产 CPU 前，不宣称 CPU 预算验收通过。

```bash
cd online
pnpm install --frozen-lockfile
pnpm test && pnpm typegen && pnpm typecheck && pnpm deploy:dry
```

## 生产模块与 HEAD 不同时的发布

生产模块与研究 HEAD 不一致时，不从 HEAD 重打包模型。`prepare-*-patch.mjs` 读取 active deployment，把生产模块逐字节保存到忽略的 `outputs/`，只增补目标改动：

| 脚本 | 用途 |
| --- | --- |
| `prepare-report-patch.mjs` | 只更新静态研究报告，保留全部推理模块 |
| `prepare-scheduler-patch.mjs` | 增加 Messenger 调度入口，保留报告资产 |
| `prepare-curve-grid-patch.mjs` | 票面包行业曲线传输补丁 |

三个脚本都只接受已审查的模块布局和绑定，生产漂移时拒绝。每次使用新输出目录，不覆盖旧包。通用流程如下，以 scheduler 为例：

```sh
cd online
node --env-file=<仓库根>/.env prepare-scheduler-patch.mjs ../outputs/scheduler-release
pnpm exec wrangler deploy --config ../outputs/scheduler-release/wrangler.jsonc --dry-run --outdir ../outputs/scheduler-release/dry
node --env-file=<仓库根>/.env prepare-scheduler-patch.mjs --verify ../outputs/scheduler-release
node --env-file=<仓库根>/.env prepare-scheduler-patch.mjs --apply ../outputs/scheduler-release
```

部署前核对 active deployment 与 `baseline.json` 一致，dry-run 的每个模块 SHA-256 与 baseline 相同。发布后下载模块，核对原模型字节、wrapper、绑定和资产哈希。报告补丁的验证还要含匿名/测试账号的 GET、HEAD、未知路径、方法和 MIME，并先部署 Quant 入口再部署 Gateway 绑定。

## 票面包（暂停）

票面包的 manifest 为 `issuance-coupon`，结果契约为 `issuance-forecast-v1`。它仍受上节资格约束，并保留代码路径。

- 统一模型预测真实发行票面，只输出 T+1、T+14、T+30（最长 30 自然日），输出“仅预测票面”，推荐日期和节约字段为空。口径见 [DOMAIN](DOMAIN.md)。
- 输入组由 manifest 固定。`issue` 组在读取时由 `public.bond_issuance` 的列生成，不读 `quant_input.issue`。`bond_history.bond_code` 按 Data 的八位整数规则存储，展示层恢复为六位主体、可选 X/X2 和交易所后缀。
- 标签只用可靠定价日和最终票面，特征严格早于预测起点。`public_only` 包把协议、模型审计和输入绑定，线上私募和未知方式的请求被拒绝。
- 缺失报价不做期限或日期插值、前向填充、训练中位数或零值填补。
- 训练使用 2026 年前标签，模型和标签历史全年冻结，每日只更新市场输入。过期包拒绝预测，2027 年日历未核实前，跨年窗口按实际终点拒绝。

本地流程：

```bash
uv run python main.py --online train --as-of YYYY-MM-DD --bundle-dir outputs/online --coupon-selection <release-evaluation.json>
node online/verify.mjs outputs/online
uv run python main.py --online infer --bundle-dir outputs/online
node online/cli.mjs outputs/online outputs/online/inputs.json
```

`--coupon-selection` 读取冻结选择和历史评价，按原始 receipt 重建校验，不重新搜索候选。训练读取只读 repeatable-read 快照，`--input-snapshot` 可完全离线回放。导出目录被忽略，含 model-main.json、历史评价证据、日历、manifest 和 Python 参考。`verify.mjs` 核对全部历史特征、缺失向量、预测、逐项贡献、加法恒等式和业务字段。证据绑定模型、输入、输出和实际 JS 文件的哈希，变更后须重新核验。

封存 MLP8 经 `scripts/adopt_frozen_mlp.py` 选用，原研究清单与 `qualified=false` 保持原样。它走恢复适配器，不进入 `CouponModel.fit()`，归因方法为 `relu_path_integrated_gradients`（编码空间的直线路径归因，不是 SHAP 或因果解释），兼容字段 `shap_bp` 继续承载 bp 贡献。该模型因数据质量问题已暂停。

大输入在免费 CPU 限制内按分片处理：`input-segments.mjs` 把完整 R2 输入按固定段读取并以 ETag/SHA 校验，`segmented-coupon.mjs` 用父子 Workflow 实例分批计算。行业曲线以 `curve-grid-v1` 无损传输，解码拒绝未知编码、错误曲线身份、无效日期、乱序和重复键，不填补空值。实现见 `online/` 对应模块及测试。
