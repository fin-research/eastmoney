// @ts-nocheck

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const LIABILITY_REPORT_EDB_CODES = Object.freeze([
	'E1707781', 'E1707782', 'E1707783', 'E1707785',
	'E1000172', 'E1000174', 'E1000176',
	'E1704281', 'E1704282', 'E1704283', 'E1704284'
]);

const LIABILITY_MARKET_SERIES = [
	{ seriesId: 'E1707781', seriesName: '中债证券公司债到期收益率(AAA-):1年', category: 'chinabond_broker_aaa_minus_yield', tenor: '1年', unit: '%' },
	{ seriesId: 'E1707782', seriesName: '中债证券公司债到期收益率(AAA-):2年', category: 'chinabond_broker_aaa_minus_yield', tenor: '2年', unit: '%' },
	{ seriesId: 'E1707783', seriesName: '中债证券公司债到期收益率(AAA-):3年', category: 'chinabond_broker_aaa_minus_yield', tenor: '3年', unit: '%' },
	{ seriesId: 'E1707785', seriesName: '中债证券公司债到期收益率(AAA-):5年', category: 'chinabond_broker_aaa_minus_yield', tenor: '5年', unit: '%' },
	{ seriesId: 'E1704284', seriesName: '同业存单发行利率(国有银行):1年', category: 'state_owned_bank_ncd', tenor: '1年', unit: '%' },
	{ seriesId: 'E1704283', seriesName: '同业存单发行利率(国有银行):9个月', category: 'state_owned_bank_ncd', tenor: '9个月', unit: '%' },
	{ seriesId: 'E1704282', seriesName: '同业存单发行利率(国有银行):6个月', category: 'state_owned_bank_ncd', tenor: '6个月', unit: '%' },
	{ seriesId: 'E1704281', seriesName: '同业存单发行利率(国有银行):3个月', category: 'state_owned_bank_ncd', tenor: '3个月', unit: '%' },
	{ seriesId: 'E1707781', seriesName: 'AAA-券商债:1年', category: 'credit_spread_broker_govt_1y', tenor: '1年', unit: '%' },
	{ seriesId: 'E1000172', seriesName: '国债:1年', category: 'credit_spread_broker_govt_1y', tenor: '1年', unit: '%' },
	{ seriesId: 'E1707783', seriesName: 'AAA-券商债:3年', category: 'credit_spread_broker_govt_3y', tenor: '3年', unit: '%' },
	{ seriesId: 'E1000174', seriesName: '国债:3年', category: 'credit_spread_broker_govt_3y', tenor: '3年', unit: '%' },
	{ seriesId: 'E1707785', seriesName: 'AAA-券商债:5年', category: 'credit_spread_broker_govt_5y', tenor: '5年', unit: '%' },
	{ seriesId: 'E1000176', seriesName: '国债:5年', category: 'credit_spread_broker_govt_5y', tenor: '5年', unit: '%' }
];

const LIABILITY_SPREAD_PAIRS = [
	{ category: 'credit_spread_broker_govt_1y', tenor: '1年', brokerSeriesId: 'E1707781', governmentSeriesId: 'E1000172' },
	{ category: 'credit_spread_broker_govt_3y', tenor: '3年', brokerSeriesId: 'E1707783', governmentSeriesId: 'E1000174' },
	{ category: 'credit_spread_broker_govt_5y', tenor: '5年', brokerSeriesId: 'E1707785', governmentSeriesId: 'E1000176' }
];

function record(value, field) {
	if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${field} 返回结构无效`);
	return value;
}

function rows(value, field, maximum, mapper) {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} 返回行数无效`);
	return value.map((item, index) => mapper(record(item, `${field}[${index}]`), index));
}

function text(value, field, { nullable = false, maximum = 1_000 } = {}) {
	if (value === null || value === undefined || value === '') {
		if (nullable) return null;
		throw new Error(`${field} 不能为空`);
	}
	const result = String(value).trim();
	if (!result || result.length > maximum) throw new Error(`${field} 无效`);
	return result;
}

function date(value, field, { nullable = false } = {}) {
	if (value === null || value === undefined || value === '') {
		if (nullable) return null;
		throw new Error(`${field} 不能为空`);
	}
	const result = String(value).slice(0, 10);
	if (!ISO_DATE.test(result)) throw new Error(`${field} 日期无效`);
	return result;
}

function number(value, field, { nullable = false, minimum = -1e12, maximum = 1e12 } = {}) {
	if (value === null || value === undefined || value === '') {
		if (nullable) return null;
		return 0;
	}
	const result = Number(value);
	if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${field} 数值无效`);
	return result;
}

function parameters(value) {
	const source = record(value ?? {}, 'Neon 报告参数');
	const entries = Object.entries(source);
	if (entries.length > 100) throw new Error('Neon 报告参数数量无效');
	return Object.fromEntries(entries.map(([code, raw]) => {
		if (!/^[a-z0-9_]{1,80}$/i.test(code)) throw new Error('Neon 报告参数编码无效');
		const item = record(raw, `Neon 报告参数 ${code}`);
		return [code, {
			label: text(item.label, `${code}.label`, { nullable: true }),
			valueYi: number(item.valueYi, `${code}.valueYi`, { nullable: true }),
			periodEnd: date(item.periodEnd, `${code}.periodEnd`, { nullable: true }),
			notes: text(item.notes, `${code}.notes`, { nullable: true, maximum: 5_000 })
		}];
	}));
}

function ratio(numerator, denominator) {
	return denominator ? numerator / denominator * 100 : null;
}

function normalizeLimitRows(value) {
	return rows(value ?? [], 'Neon 融资额度', 100, (item) => ({
		debtType: text(item.debtType, '额度品种'),
		limitYi: number(item.limitYi, '额度上限'),
		configuredLimitYi: number(item.configuredLimitYi, '配置额度'),
		issuedYi: number(item.issuedYi, '已用额度'),
		remainingYi: number(item.remainingYi, '剩余额度'),
		usageBasis: text(item.usageBasis, '额度口径'),
		approvedDate: date(item.approvedDate, '额度获批日', { nullable: true }),
		expiryDate: date(item.expiryDate, '额度到期日', { nullable: true }),
		calculationMode: text(item.calculationMode, '额度计算方式'),
		sortOrder: number(item.sortOrder, '额度排序', { minimum: -100_000, maximum: 100_000 }),
		needsNetCapitalUpdate: Boolean(item.needsNetCapitalUpdate)
	}));
}

function compareMarketRows(left, right) {
	return left.category.localeCompare(right.category)
		|| left.seriesId.localeCompare(right.seriesId)
		|| left.observationDate.localeCompare(right.observationDate);
}

/**
 * Converts raw, read-only public.edb observations fetched through the Data API
 * into the chart contract. Broker-government spreads are intentionally derived
 * here so the database only scans the source rows once.
 */
export function buildLiabilityMarketRateReport(value, expectedAsOfDate) {
	const asOfDate = date(expectedAsOfDate, '负债周报日期');
	const yearStart = `${asOfDate.slice(0, 4)}-01-01`;
	const allowedCodes = new Set(LIABILITY_REPORT_EDB_CODES);
	const rawRows = rows(value ?? [], 'Neon EDB 原始观测', 5_000, (item) => {
		const indicatorCode = text(item.indicator_code, 'EDB 指标编码');
		if (!allowedCodes.has(indicatorCode)) throw new Error(`EDB 指标编码 ${indicatorCode} 不在周报白名单`);
		const observationDate = date(item.observation_date, 'EDB 观测日期');
		if (observationDate < yearStart || observationDate > asOfDate) throw new Error(`EDB 观测日期 ${observationDate} 超出周报区间`);
		return {
			indicatorCode,
			observationDate,
			value: number(item.value, 'EDB 观测值', { nullable: true })
		};
	});
	const observationsBySeriesAndDate = new Map();
	for (const item of rawRows) {
		observationsBySeriesAndDate.set(`${item.indicatorCode}\u0000${item.observationDate}`, item.value);
	}

	const marketHistory = [];
	for (const item of rawRows) {
		for (const definition of LIABILITY_MARKET_SERIES) {
			if (definition.seriesId !== item.indicatorCode) continue;
			marketHistory.push({
				...definition,
				observationDate: item.observationDate,
				value: item.value
			});
		}
	}
	for (const pair of LIABILITY_SPREAD_PAIRS) {
		for (const item of rawRows) {
			if (item.indicatorCode !== pair.brokerSeriesId || item.value == null) continue;
			const governmentValue = observationsBySeriesAndDate.get(`${pair.governmentSeriesId}\u0000${item.observationDate}`);
			if (governmentValue == null) continue;
			marketHistory.push({
				seriesId: `${pair.brokerSeriesId}-${pair.governmentSeriesId}`,
				seriesName: `${pair.tenor}信用利差`,
				category: pair.category,
				tenor: pair.tenor,
				observationDate: item.observationDate,
				value: (item.value - governmentValue) * 100,
				unit: 'bp'
			});
		}
	}
	marketHistory.sort(compareMarketRows);

	const latestByCategoryAndSeries = new Map();
	for (const item of marketHistory) {
		const key = `${item.category}\u0000${item.seriesId}`;
		const previous = latestByCategoryAndSeries.get(key);
		if (!previous || item.observationDate > previous.observationDate) latestByCategoryAndSeries.set(key, item);
	}
	const marketObservations = [...latestByCategoryAndSeries.values()].sort((left, right) =>
		left.category.localeCompare(right.category)
		|| String(left.tenor ?? '').localeCompare(String(right.tenor ?? ''), 'zh-CN')
		|| left.seriesName.localeCompare(right.seriesName, 'zh-CN')
	);
	return { marketHistory, marketObservations };
}

/**
 * @param {unknown} value
 * @param {unknown[]} marketRateRows
 * @param {string} expectedAsOfDate
 * @param {string | null} [sourceError]
 */
export function attachLiabilityMarketRates(value, marketRateRows, expectedAsOfDate, sourceError = null) {
	const payload = record(value, 'Neon 周报业务聚合');
	if (Number(payload.version) !== 1) throw new Error('Neon 周报业务聚合版本无效');
	const report = record(payload.report, 'Neon 周报业务数据');
	const asOfDate = date(report.asOfDate, 'Neon 周报日期');
	if (asOfDate !== expectedAsOfDate) throw new Error(`Neon 周报日期 ${asOfDate} 与所选日期 ${expectedAsOfDate} 不一致`);
	const marketRateError = text(sourceError, '市场利率读取错误', { nullable: true, maximum: 500 });
	return {
		...payload,
		report: {
			...report,
			...buildLiabilityMarketRateReport(marketRateRows, expectedAsOfDate),
			marketRateError
		}
	};
}

export function emptyLiabilityWeeklyReport(asOfDate) {
	const reportDate = date(asOfDate, '负债周报日期');
	return {
		asOfDate: reportDate,
		today: reportDate,
		staleDays: 0,
		metrics: {},
		quality: {},
		parameters: {},
		composition: [],
		maturityDistribution: [],
		maturityByType: [],
		annualMaturity: [],
		balanceRateTrend: [],
		issuanceTrend: [],
		events: [],
		dueDetails: [],
		projects: [],
		marketObservations: [],
		marketHistory: [],
		limits: [],
		limitTotals: { limitYi: null, issuedYi: null, remainingYi: null },
		financeParameterReminder: false,
		peerIssueSummary: [],
		peerIssuances: [],
		registrationProgress: []
	};
}

/**
 * Validates the report payload returned directly by the authenticated Neon
 * Data API RPC. Only known fields are retained before the snapshot is saved.
 */
export function normalizeLiabilityReportDatabasePayload(value, expectedAsOfDate) {
	const payload = record(value, 'Neon 周报聚合');
	if (Number(payload.version) !== 1) throw new Error('Neon 周报聚合版本无效');
	const raw = record(payload.report, 'Neon 周报数据');
	const asOfDate = date(raw.asOfDate, 'Neon 周报日期');
	if (asOfDate !== expectedAsOfDate) throw new Error(`Neon 周报日期 ${asOfDate} 与所选日期 ${expectedAsOfDate} 不一致`);
	const today = date(raw.today, 'Neon 当前日期');
	const reportParameters = parameters(raw.parameters);
	const balanceYi = number(raw.balanceYi, '主动负债余额');
	const liveBalanceYi = number(raw.liveBalanceYi, '实时明细余额');
	const balanceSnapshotDate = date(raw.balanceSnapshotDate, '余额快照日期', { nullable: true });
	const reconciliationComparable = balanceSnapshotDate === asOfDate;
	const reconciliationDeltaYi = reconciliationComparable ? liveBalanceYi - balanceYi : null;
	const longBalanceYi = number(raw.longBalanceYi, '长期负债余额');
	const shortBalanceYi = number(raw.shortBalanceYi, '短期负债余额');
	const weightedRate = number(raw.weightedRate, '加权融资利率', { nullable: true });
	const previousMonthRate = number(raw.previousMonthRate, '上月末融资利率', { nullable: true });
	const previousYearRate = number(raw.previousYearRate, '上年末融资利率', { nullable: true });
	const weightedRatePct = weightedRate == null ? null : weightedRate * 100;
	const previousMonthRatePct = previousMonthRate == null ? null : previousMonthRate * 100;
	const previousYearRatePct = previousYearRate == null ? null : previousYearRate * 100;
	const weightedRemainingDays = number(raw.weightedDays, '加权剩余期限', { nullable: true });
	const previousMonthDays = number(raw.previousMonthDays, '上月末剩余期限', { nullable: true });
	const previousYearDays = number(raw.previousYearDays, '上年末剩余期限', { nullable: true });
	const cumulativeBorrowingYi = number(raw.cumulativeBorrowingYi, '累计新增借款');
	const netCapital = reportParameters.prior_month_net_capital?.valueYi;
	const securitiesNetAssets = reportParameters.securities_prior_year_net_assets?.valueYi;
	const groupNetAssets = reportParameters.group_prior_year_net_assets?.valueYi;

	const report = {
		asOfDate,
		today,
		staleDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOfDate}T00:00:00Z`)) / 86_400_000)),
		metrics: {
			balanceYi,
			balanceMonthChangeYi: balanceYi - number(raw.previousMonthBalanceYi, '上月末负债余额'),
			balanceYearChangeYi: balanceYi - number(raw.previousYearBalanceYi, '上年末负债余额'),
			weightedRatePct,
			weightedRateMonthBp: weightedRatePct == null || previousMonthRatePct == null ? null : (weightedRatePct - previousMonthRatePct) * 100,
			weightedRateYearBp: weightedRatePct == null || previousYearRatePct == null ? null : (weightedRatePct - previousYearRatePct) * 100,
			weightedRemainingDays,
			remainingMonthChangeDays: weightedRemainingDays == null || previousMonthDays == null ? null : weightedRemainingDays - previousMonthDays,
			remainingYearChangeDays: weightedRemainingDays == null || previousYearDays == null ? null : weightedRemainingDays - previousYearDays,
			longBalanceYi,
			shortBalanceYi,
			longBalanceRatio: longBalanceYi + shortBalanceYi ? longBalanceYi / (longBalanceYi + shortBalanceYi) * 100 : null,
			due30Yi: number(raw.due30Yi, '未来30天到期'),
			dueYearYi: number(raw.dueYearYi, '年内到期'),
			shortCompanyDebtYi: number(raw.shortCompanyDebtYi, '短期公司债余额'),
			shortCompanyDebtRatio: ratio(number(raw.shortCompanyDebtYi, '短期公司债余额'), netCapital),
			shortDebtYi: number(raw.shortDebtYi, '一年内短期负债'),
			shortDebtRatio: ratio(number(raw.shortDebtYi, '一年内短期负债'), netCapital),
			largestBorrowingYi: number(raw.largestBorrowingYi, '新增单笔借款'),
			largestBorrowingRatio: ratio(number(raw.largestBorrowingYi, '新增单笔借款'), securitiesNetAssets),
			cumulativeBorrowingYi,
			cumulativeBorrowingDate: date(raw.cumulativeBorrowingDate, '累计新增借款日期', { nullable: true }),
			cumulativeSecuritiesRatio: ratio(cumulativeBorrowingYi, securitiesNetAssets),
			cumulativeGroupRatio: ratio(cumulativeBorrowingYi, groupNetAssets)
		},
		quality: {
			balanceSnapshotDate,
			liveBalanceYi,
			reconciliationComparable,
			reconciliationDeltaYi,
			rateCoveragePct: number(raw.rateCoverage, '利率覆盖率') * 100,
			lifecycleCoveragePct: number(raw.lifecycleCoverage, '期限覆盖率') * 100,
			liveDerivedReliable: reconciliationComparable ? Math.abs(reconciliationDeltaYi) < 0.005 : null,
			marketRateError: text(raw.marketRateError, '市场利率读取错误', { nullable: true, maximum: 500 }),
			missingMaturityCount: number(raw.missingMaturityCount, '缺失到期日数量', { minimum: 0, maximum: 1_000_000 }),
			missingMaturityAmountYi: number(raw.missingMaturityAmountYi, '缺失到期日金额', { minimum: 0 }),
			missingMaturityDetails: text(raw.missingMaturityDetails, '缺失到期日明细', { nullable: true, maximum: 10_000 })
		},
		parameters: reportParameters,
		composition: rows(raw.composition ?? [], '负债结构', 100, (item) => ({ type: text(item.type, '负债品种'), amountYi: number(item.amountYi, '负债结构金额') })),
		maturityDistribution: rows(raw.maturityDistribution ?? [], '逐月到期', 24, (item) => ({ month: text(item.month, '到期月份'), amountYi: number(item.amountYi, '到期金额') })),
		maturityByType: rows(raw.maturityByType ?? [], '分品种逐月到期', 1_000, (item) => ({ month: text(item.month, '到期月份'), type: text(item.type, '到期品种'), amountYi: number(item.amountYi, '到期金额') })),
		annualMaturity: rows(raw.annualMaturity ?? [], '年度到期', 1_000, (item) => ({ bucket: text(item.bucket, '到期年度'), bucketOrder: number(item.bucketOrder, '到期年度排序'), type: text(item.type, '到期品种'), amountYi: number(item.amountYi, '到期金额') })),
		balanceRateTrend: rows(raw.balanceRateTrend ?? [], '余额利率走势', 240, (item) => ({ date: date(item.date, '余额趋势日期'), balanceYi: number(item.balanceYi, '余额趋势金额'), weightedRatePct: number(item.weightedRatePct, '余额趋势利率', { nullable: true }) })),
		issuanceTrend: rows(raw.issuanceTrend ?? [], '公司发行走势', 100, (item) => ({ month: text(item.month, '发行月份'), type: text(item.type, '发行业务品种'), amountYi: number(item.amountYi, '发行金额'), weightedRatePct: number(item.weightedRatePct, '发行利率', { nullable: true }) })),
		events: rows(raw.events ?? [], '近期负债动态', 1_000, (item) => ({ kind: text(item.kind, '动态类型'), date: date(item.date, '动态日期'), week: text(item.week, '动态周次'), id: text(item.id, '动态ID'), name: text(item.name, '动态名称'), debtType: text(item.debtType, '动态品种'), amountYi: number(item.amountYi, '动态金额'), href: text(item.href, '动态链接') })),
		dueDetails: rows(raw.dueDetails ?? [], '到期明细', 100, (item) => ({ id: text(item.id, '到期负债ID'), debt_type: text(item.debt_type, '到期品种'), counterparty: text(item.counterparty, '到期对手方', { nullable: true }), principalYi: number(item.principal_yi, '到期本金'), interestYi: number(item.interest_yi, '到期利息'), annualRatePct: item.annual_rate == null ? null : number(item.annual_rate, '到期利率') * 100, dueDate: date(item.due_date, '到期日') })),
		projects: rows(raw.projects ?? [], '融资项目', 1_000, (item) => ({ id: text(item.id, '项目ID'), name: text(item.name, '项目名称'), debtType: text(item.debtType, '项目品种'), amountYi: number(item.amountYi, '项目金额'), plannedIssueDate: date(item.plannedIssueDate, '计划发行日', { nullable: true }), plannedMaturityDate: date(item.plannedMaturityDate, '计划到期日', { nullable: true }), status: text(item.status, '项目状态'), ownerName: text(item.ownerName, '项目负责人', { nullable: true }), notes: text(item.notes, '项目说明', { nullable: true, maximum: 10_000 }), expectedRateMin: number(item.expectedRateMin, '预计利率下限', { nullable: true }), expectedRateMax: number(item.expectedRateMax, '预计利率上限', { nullable: true }), fundingCostRate: number(item.fundingCostRate, '资金成本', { nullable: true }), tenorDescription: text(item.tenorDescription, '期限说明', { nullable: true }), amountDescription: text(item.amountDescription, '规模说明', { nullable: true }) })),
		marketObservations: rows(raw.marketObservations ?? [], '市场最新值', 100, (item) => ({ seriesId: text(item.seriesId, '市场指标'), seriesName: text(item.seriesName, '市场指标名称'), category: text(item.category, '市场分类'), tenor: text(item.tenor, '市场期限', { nullable: true }), observationDate: date(item.observationDate, '市场数据日期'), value: number(item.value, '市场数据值', { nullable: true }), unit: text(item.unit, '市场数据单位') })),
		marketHistory: rows(raw.marketHistory ?? [], '市场历史值', 20_000, (item) => ({ seriesId: text(item.seriesId, '市场指标'), seriesName: text(item.seriesName, '市场指标名称'), category: text(item.category, '市场分类'), tenor: text(item.tenor, '市场期限', { nullable: true }), observationDate: date(item.observationDate, '市场数据日期'), value: number(item.value, '市场数据值', { nullable: true }), unit: text(item.unit, '市场数据单位') }))
	};
	const limits = normalizeLimitRows(payload.limits);
	const limitTotals = limits.reduce((total, item) => ({
		limitYi: total.limitYi + item.limitYi,
		issuedYi: total.issuedYi + item.issuedYi,
		remainingYi: total.remainingYi + item.remainingYi
	}), { limitYi: 0, issuedYi: 0, remainingYi: 0 });
	return {
		...report,
		limits,
		limitTotals,
		financeParameterReminder: limits.some((item) => item.needsNetCapitalUpdate)
	};
}
