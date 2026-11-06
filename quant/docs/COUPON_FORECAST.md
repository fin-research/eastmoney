# 票面预测 coupon-forecast-v3

对象是东方财富证券股份有限公司的四个品种：3年/5年 × 公募债/次级债。预测发行利率 = 行业曲线锚点 + 发行人溢价 + 曲线短期走势 + 因子修正。

- **锚点**：决策日前最近报价日，AAA 证券公司债曲线在该期限节点的收益率。
- **发行人溢价**：该发行人最近 5 笔同类型发行（公募债或次级债）相对其定价日前曲线的偏离中位数，至少 2 笔，标签公布满一天后才可用。
- **曲线短期走势**：同日 `timing-advice-v2` 的 `catch_up_bp`。
- **因子修正**：Huber 回归（alpha 300），121 个标准化因子，对前三项之外的残差建模。因子是利率、资金、行业曲线、一级发行、36 个经济数据序列（月频按发布日对齐，日频取最近观测）、发行人存量债估值。
- **未来发行窗口**：决策日起 10 个报价日。第 1—3 个报价日沿同日 `wait_bp` 线性漂移，之后持平。

贡献是线性精确拆分：模型基值（锚点 + 发行人溢价 + 截距）加各因子贡献等于预测发行利率，七大类为利率、信用、资金面、基本面、一级发行、二级行情、发行条款。数据库按 1e-6 校验。

## 数据规则

- 输入严格早于决策日。曲线必须到前一报价日，任一模型因子缺失即拒绝预测，不填补。
- 唯一的插补：发行人存量债估值，曲线按期限线性插值，缺报的发行人估值最多沿用 20 个报价日。
- 发行人估值读 `public.bond_history_observations(date[])`，按身份映射归并别名，不累加别名余额。
- 二级成交（9 月 17 日起停更）不进入线上模型，历史上也没有改善。

## 证据

2019 年起训练，2021 年预热，逐月重训。开发期 2022-01-06 至 2025-12-18（311 笔），2026 留出 2026-01-07 至 2026-10-21（62 笔）：

|口径|平均误差 bp|±5bp 命中率|胜率（误差小于发行人溢价基线）|
|---|---:|---:|---:|
|开发期|7.04|58.5%|56.9%|
|2026|3.69|71.0%|51.6%|

对比：基线（锚点 + 发行人溢价）开发期 7.23，加曲线走势 7.09，全因子 Huber 加走势 7.04。因子修正相对“基线 + 走势”的差为 −0.06bp，95% 区间 [−0.43, 0.28]，不显著。数据规模、因子数量和模型复杂度都没有带来可检验的增益，只有曲线走势一项有显著性（相对基线 −0.14bp）。模型、因子集合和 alpha 是看过全部数据后选定的，不是事前登记。次级债误差明显大于公募债（约 15bp 对 6bp）。

## 运行

```sh
# 构建固定参数包（训练表和 walk-forward 工件在忽略目录），读 Neon，不上传
uv run python scripts/adopt_coupon_forecast.py --training <events.pkl> --walk-forward <wf.json> \
  --timing-result outputs/timing-nowcast-<日期>/result.json --output outputs/coupon-forecast-<日期> --as-of <日期>
cd online && node verify-coupon.mjs ../outputs/coupon-forecast-<日期>
```

```sh
node publish.mjs ../outputs/coupon-forecast-<日期> --stage-only   # 先暂存模型对象
pnpm run deploy                                                   # 部署含票面步骤的 Worker
node publish.mjs ../outputs/coupon-forecast-<日期>                # 最后写指针 current-coupon.json
```

`adopt_coupon_forecast.py` 拒绝 walk-forward 工件与所打包模型的 alpha、因子集合、目标不一致。Workflow 在 `timing-advice-v2` 发布之后读指针 `quant-trial/models/current-coupon.json`，没有指针、包过期或模型资格未激活时静默跳过，不影响择时结果。包有效至 2026-12-31，跨 2027 年前须核验新日历并重新训练。
