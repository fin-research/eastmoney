# 现行二级池运营周报口径

基准为新版二级债券池运营周报，停止维护的旧 bond 页不作模板。来源与代码快照见 [provenance.json](provenance.json)。图表来自同版业务 renderer，适配为离线 SVG；不从网站截屏。

## 日期和对账

- 台账日期只看 inventory.databaseDates（持仓已入库日期）。默认本年 01-01 至 asOf 之前最新台账日，包含 asOf 当日；无当年台账保持当年空状态。指定区间则按指定区间查询。
- currentPerformance.date 是报告基准日，必须匹配所选范围最新台账日。图1剔除 01-01 基准行，按所选范围绘制。历史报告不得借用以后的值。三项审计 scale / leverage / profit 完整且通过后才输出报告；容差分别为 1 元、0.000001、1 元。审计缺失、无效或失败仅输出核对结果。
- 本周营收从基准日所在周一至基准日的区间内 dailyRevenue 加总。若用户区间从周中开始，仅展示“本周区间内营收”，不宣称完整周收入。

## 五项指标

| 指标 | 字段 / 派生 | 展示 |
| --- | --- | --- |
| 业务本金 | currentPerformance.principal | 元除以 1e8，亿；附 timeWeightedPrincipal |
| 全池持仓总市值 | detailMarketValue | 亿；附基准日 operatingTrend 的 tradingMarketValue / availableMarketValue |
| 全池综合杠杆率 | detailMarketValue / currentPerformance.principal，本金须正 | 小数乘 100%；与 100% 平层比较 |
| 含免税年化收益率 | 基准日 operatingTrend.fullPoolYtdAnnualizedReturn | 小数乘 100%，3位；附 fullPoolYtdExTaxAnnualizedReturn 和 flatStatic |
| 累计毛利（含免税） | currentPerformance.cumulativeProfit | 元除以 1e4，万元；附基准日 cumulativeTaxExemptProfit |

新版运营页使用 fullPoolYtd*，不能改填 daily_statistics 的 ytdAnnualizedReturn / ytdExTaxAnnualizedReturn 源字段。全池累计收益按台账时间加权本金与自然日年化，服务已有计算；脚本不重新推算。免税增厚缺失仍为空，不能由缺失列补零或减出虚构收益。

## 账户、资产与风险

- 本金、时间加权本金、总市值、杠杆、累计毛利、年化收益率、平层静态与 DV01 均为全池（交易户+可供户）。账户没有独立业务本金。账户收益贡献以全池本金为分母；本报告不自行重建账户本金。
- 资产类别只用 tradingHoldingTypes；期限只用 tradingMaturityBuckets；重仓只用 topTradingPositions。不要用 holdingTypes/maturityBuckets 的全池分组替换。
- 一年内占比为 tradingMaturityBuckets 前5档合计（1月以内、1-3月、3-6月、6-9月、9-12月）。Top 5 为交易户市值排序的原 DTO，不重新按收益排序。
- 修正久期为 currentPerformance.modifiedDuration；DV01 为基准日 operatingTrend.dv01，单位元/BP，展示万元/BP。
- flatStatic、reportYield、weightedYield 的数值是源百分数，例如 2.5 显示 2.500%；fullPoolYtd* 与 share / leverage 为小数，例如 0.025 显示 2.500%。严禁混用。
- 质押和可用只展示 availability.pledgedMarketValue / availableMarketValue（全价持仓市值）。它们来自逐券市值乘数量比例；不得使用兼容 FaceAmount、固定100元单价、临时40亿元，不能称为回购融资余额。历史缺失是 null，明确零值是 0。
- 图1仅在最新时点加质押点，缺失不画；不增质押曲线。规模、杠杆、收益、累计创收及交易户配置图沿用包内 core.mjs 同版业务 renderer。
- 风险指标如供后续分析：波动率为区间内本金>0有效日“dailyRevenue/principal”的样本标准差乘√252，回撤为复合净值峰谷跌幅；直接消费 returnRiskMetrics，不能将此年化规则套到运营收益率。

## 表达

保持“规模演变与杠杆走势、收益率与累计创收归因、资产配置与期限分布、核心重仓券速览、后续跟踪重点”顺序。前四项由脚本依据数据生成，模型只写最后一项。来源和取数时间放 HTML 折叠来源区及审计 JSON。正文不堆叠口径注释；不补充无数据支持的市场原因和主观评级。
