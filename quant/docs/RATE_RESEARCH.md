# 债券利率与发行择时研究

## 目标

发行人要控制的是实际融资利率和等待风险。原逐笔模型只描述发行利差相对同类近 30 日可比债的偏离。它不能替代无风险利率、信用利差和发行时点的联合预测。

`main.py --rate-research` 复用统一特征注册表，只读本地报价，不更新 Choice，不上传。产物在忽略的 `outputs/rate-research/`，不提交数据、模型或生成报告。

```bash
uv run python main.py --rate-research --research-output outputs/rate-research/development-daily
uv run python -m unittest discover -s tests -p test_rate_research.py -v
```

## 信息集与标签

- 决策时点为 T 日开盘前，特征只用严格早于 T 的最新完整报价。
- `h=0` 预测 T 日收盘收益率相对前一完整报价的变化。`h=1..30` 为自然日，到期日休市时取窗口内最后一个报价日。尾部未成熟的窗口不生成标签。长假保留起点并记录报价年龄。
- 标签单位为 bp，绝对收益率百分数为 `level_bp / 100`。
- 独立目标是 3Y 国债、3Y AAA 企业债收益率及二者信用利差。企业债二级收益率只是融资环境代理，不是证券公司一级票面。5Y、发行人和次级条款需要独立的定价校准。
- 历史评价用真实报价日期。未来可执行发行日须用有来源和覆盖年份检查的交易所日历，不能只筛周一到周五。
- 特征含统一资金面、曲线、信用利差、日历，以及报价日收益率变化、相对均线偏离和变化波动。市场水平用百分数，变化特征用 bp。发布日期和历史版本未经确认的宏观、公司数据不进入候选。

## 模型与验证

- `model/rate_forecast.py` 显式注册候选：随机游走、历史漂移、不同正则和历史长度的 Ridge、浅层 LightGBM。另有向随机游走收缩的模型，和短期预测饱和后可选漂移延伸的模型。分解候选把同起点同终点的国债与信用利差预测相加。
- 每轮记录全部候选，不只存最好的。候选固定树数，不用外层评分集早停。调参的早停和搜索只在训练窗口内按标签成熟时间再隔离。
- 2019 年起的历史作训练，2022—2025 年按季度扩展窗口评分。每个训练标签终点必须严格早于测试季度首日，Ridge 的缺失填充和缩放器只在该折训练样本上拟合。每条预测保留起点、源日期、目标终点、训练标签最后日期、样本数、候选和季度。
- 是否已有留出期被观察，以冻结协议和实验记录为准，不能仅凭按年份切分宣称独立测试。打开留出结果前，在忽略目录保存不可覆盖的冻结协议。协议含代码版本与校验值、源数据校验值、候选、决策规则、区间规则和评价区间。继续利用该年份优化后，它就是研究参考集，不再称独立封存测试。

验收看：

1. 各期限、各年度的 MAE/RMSE、相对随机游走的改善、方向和偏差。国债与信用利差分开检查。
2. 固定起点选日：只凭起点预测选择，未来实际收益率只用于评分。
3. 每天重新判断的停止策略（`model/rate_policy.py`）：当天预测决定继续等待或发行，到最迟日期强制执行。不能先看完整真实行情再选最低日。缺预测的起点保留明确状态，不缩小分母。
4. 与立即发行、固定截止日发行比较：收益率代理差额、等待比例、后悔成本、最差年份。
5. 重叠起点用保留连续性的 moving-block bootstrap，同时报告固定规则取样的非重叠窗口结果。开发期区间不消除模型选择偏差。

所有评价都是市场代理效果，不能乘发行规模宣传为公司已实现的节约。

`model/rate_intervals.py` 用同一候选、同一期限最近 252 条已成熟的样本外残差校准 90% 等尾区间，至少需要 120 条，每个起点只用 `label_end < origin` 的残差。“比当日发行便宜”的概率，用同一历史起点未来日与当日的成对残差差计算。不假设不同期限的误差独立。缺校准样本时不提供区间。

## 一级发行票面定价

```bash
# 使用已落地的发行资料，默认不消耗外部额度
uv run python main.py --primary-research --research-output outputs/rate-research/primary-pricing
# 显式补取日期、发行时评级、最终票面；成功批次原子保存，可断点继续
uv run python main.py --primary-research --refresh-pricing-metadata --research-output outputs/rate-research/primary-pricing
```

- `data/primary_pricing.py` 只研究 SH/SZ 交易所 1—10 年、固定利率、无含权条款的证券公司债及次级债。未知条款不混入标准发行方案。原始工作簿不修改，不要求用不到的“发行利差”有值。
- `TENDERDATE` 是招投标/簿记日，`ISSUE_DATE` 是原报表的发行起始日，二者不强制相同。定价晚于发行起始的记录先隔离，待公告核实。没有有效定价日期的行排除，不用发行日或公告日冒充簿记日。`TENDERBIDDINGDATE` 返回时段，不解析为日期。
- 输入用严格早于定价日的市场报价。标签是 `TENDERFINALCOUPON` 最终票面。用定价日的 AAA 企业债 3Y 二级收益率分解发行溢价，这个当日价格只出现在标签中，不进入当日信息集。历史标签在定价日和发行起始日都过去后才可供后续估计使用。
- 评级用 `ISSCORPCREDITRAT` 的发行时主体评级，并统计与原快照评级的差异。
- `model/primary_pricing.py` 比较六类估计：二级市场基准、同类可比债、发行人自身历史溢价、向同类收缩、相对同类的偏离、上一笔实际票面。同类按类型、评级、期限划分。默认发行人的候选是自身溢价的 90 自然日半衰期加权中位数。冷启动回退同类，缺同类样本则不生成估计。参数来源须可回溯到开发结果，并单独检查目标发行人，不只按全市场平均选择。
- 历史只保留最近 730 天。同发行人同日同方案的多只债聚合为一个观察，有效样本数按日期权重计算，不把发行规模当样本量。
- 逐发行时点评分，不用未成熟或同日其他发行的结果。比较 MAE/RMSE 用共同可比样本，保留覆盖数、未估计数和分年度结果，不删困难发行。
- 当前 3Y/5Y 普通债和次级债的候选报价写入 `primary-current.csv`，选定方案写入 `primary-assessment.json`。它只是票面定价研究，不替代生产结构化输出。
- 90% 误差区间只用定价前已成熟的样本外残差，按同评级/期限/类型校准，至少 30 个发行观察、最多最近 252 个。缺样本时不编造区间。`primary-intervals.csv` 用于检查历史覆盖和宽度。

## 本地发行预测入口

```bash
uv run python main.py --window-days 30
uv run python main.py --as-of 2026-09-21 --input-snapshot outputs/issuance_forecast/inputs.json
```

`--issuance-forecast` 是同一路径的显式别名。入口使用统一票面模型，`--window-days` 只接受 30，旧市场模型和等待成本（非零 `--waiting-cost-bp-day`）被拒绝。运行前检查所选模型资格，见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md)。

- 输出在 `outputs/issuance_forecast/`（`--forecast-output` 可更换）：`inputs.json`、`issuance_forecast.json`、`forecast.csv` 和线上包 `online/`，文字报告打印到标准输出。
- 默认通过只读 repeatable-read 事务读取 Neon 的资金和发行定价数据并保存快照，不调用 Choice，不改写 Excel。`--input-snapshot` 可离线重放。
- 日历采用已核对的 2026 年交易所休市与调休规则，未知年份报错，不猜节假日。最新行情必须覆盖模型日期前一个报价工作日，过期输入拒绝预测。
- 所有历史样本的市场来源、训练标签和发行结果都早于对应预测时点。证据缓存只在内容与算法签名一致时复用。2026 年已被观察，后续评价只作历史参考。

票面与贡献口径见 [DOMAIN](DOMAIN.md)。回测见 [ISSUANCE_BACKTEST](ISSUANCE_BACKTEST.md)。

方法参考：[scikit-learn 时序滞后特征与隔离验证](https://scikit-learn.org/stable/auto_examples/applications/plot_time_series_lagged_features.html)，[Diebold 与 Li 的收益率曲线动态研究](https://www.nber.org/papers/w10048)。两者不构成中国债市短期模型有效的证据。
