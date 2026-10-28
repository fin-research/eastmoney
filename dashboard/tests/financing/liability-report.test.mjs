import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
	CTR_INDICATOR_LIST,
	fetchManualLiabilitySources,
	normalizeManualLiabilitySources
} from '../../src/lib/financing/liability-choice.js';
import {
	attachLiabilityMarketRates,
	buildLiabilityMarketRateReport,
	normalizeLiabilityReportDatabasePayload
} from '../../src/lib/financing/liability-report-data.js';

function ctrRow(overrides = {}) {
	return {
		...Object.fromEntries(CTR_INDICATOR_LIST.map((field) => [field, null])),
		SECUCODE: '123456.SH',
		BOND_NAME_ABBR: '26测试01',
		BOND_TYPE: '证券公司债',
		ISSUE_DATE: '2026-09-02',
		ACTUAL_ISSUE_SCALE: 20,
		BOND_EXPIRE_YEAR: 3,
		ISSUERATE_REFERENCE: 2.18,
		DEC_TOMRTYYEAR1: '3年',
		ISSUER_NAME: '测试证券股份有限公司',
		...overrides
	};
}

test('browser-safe liability report fetch uses CTR and paged DM registrations without EDB', async () => {
	const requests = [];
	const result = await fetchManualLiabilitySources({
		dataApiUrl: 'https://data.example/data',
		asOfDate: '2026-09-03',
		fetchImpl: async (url) => {
			requests.push(String(url));
			return String(url).includes('/choice/ctr')
				? Response.json({ function: 'CTR', fields: CTR_INDICATOR_LIST, rows: [] })
				: Response.json({ hasNextPage: false, rows: [] });
		}
	});
	assert.equal(requests.length, 2);
	assert.equal(requests.filter((url) => url.includes('/choice/edb')).length, 0);
	assert.equal(requests.filter((url) => url.includes('/choice/ctr')).length, 1);
	assert.equal(requests.filter((url) => url.includes('/broker-bond-registrations')).length, 1);
	const ctrRequest = requests.find((url) => url.includes('/choice/ctr'));
	const ctrUrl = new URL(ctrRequest);
	assert.equal(ctrUrl.pathname, '/data/choice/ctr');
	assert.equal(ctrUrl.searchParams.get('reportName'), 'BondIssueDetail');
	const ctrOptions = ctrUrl.searchParams.get('options');
	assert.match(ctrOptions, /Bond_Type=646003/);
	assert.match(ctrOptions, /Frequency=1/);
	assert.match(ctrOptions, /Issue_Date_Type=2/);
	assert.match(ctrOptions, /Company_Type=-/);
	assert.deepEqual(result.issuanceWindow, { startDate: '2026-01-01', endDate: '2026-09-03' });
	assert.deepEqual(result.weekWindow, { startDate: '2026-08-31', endDate: '2026-09-03' });
	assert.equal(result.ctr.status, 'available');
	const registrationUrl = new URL(requests.find((url) => url.includes('/broker-bond-registrations')));
	assert.equal(registrationUrl.searchParams.get('pageNum'), '1');
	assert.equal(registrationUrl.searchParams.get('pageSize'), '50');
	assert.equal(registrationUrl.searchParams.get('startDate'), '2026-08-31');
	assert.equal(registrationUrl.searchParams.get('endDate'), '2026-09-03');
	assert.match(registrationUrl.searchParams.get('fields'), /projectName,issuerName,status,variety,amountYi/);
	assert.equal(result.registration.status, 'available');
});

test('server snapshot validation rebuilds expected CTR and DM request contracts', () => {
	const sources = normalizeManualLiabilitySources({
		issuanceWindow: { startDate: 'tampered', endDate: 'tampered' },
		ctr: {
			status: 'available',
			function: 'CTR',
			request: { reportName: 'tampered' },
			fields: CTR_INDICATOR_LIST,
			rows: [{ ...ctrRow(), ignored: 'not-requested' }]
		},
		registration: {
			status: 'available',
			fields: [
				'projectName', 'issuerName', 'status', 'variety', 'amountYi', 'region', 'industry',
				'leadUnderwriter', 'noticeNumber', 'venue', 'registrationOrFiling', 'updateDate'
			],
			rows: [{
				projectName: '测试项目', issuerName: '测试证券股份有限公司', status: '已受理',
				variety: '小公募', amountYi: 100, updateDate: '2026-09-02'
			}]
		}
	}, '2026-09-03');
	assert.deepEqual(sources.issuanceWindow, { startDate: '2026-01-01', endDate: '2026-09-03' });
	assert.deepEqual(sources.weekWindow, { startDate: '2026-08-31', endDate: '2026-09-03' });
	assert.equal(sources.ctr.request.reportName, 'BondIssueDetail');
	assert.equal(sources.ctr.rows[0].ignored, undefined);
	assert.deepEqual(sources.peerIssuances[0], {
		securityCode: '123456.SH', bondName: '26测试01', issuerName: '测试证券股份有限公司',
		bondType: '公募债', actualIssueAmountYi: 20, issueTenor: '3年', issueDate: '2026-09-02',
		maturityDate: null, market: '上交所', couponRatePct: 2.18
	});
	assert.deepEqual(sources.peerIssueSummary, [{ issuerName: '测试证券股份有限公司', bondType: '公募债', amountYi: 20 }]);
	assert.deepEqual(sources.registration.rows, [{
		projectName: '测试项目', issuerName: '测试证券股份有限公司', status: '已受理',
		variety: '小公募', amountYi: 100, region: null, industry: null,
		leadUnderwriter: null, noticeNumber: null, venue: null,
		registrationOrFiling: null, updateDate: '2026-09-02'
	}]);
	assert.deepEqual(normalizeManualLiabilitySources({ ctr: { status: 'missing' } }, '2026-09-03').peerIssuances, []);
});

test('Neon report RPC payload is date-bound and normalized before snapshotting', () => {
	const payload = {
		version: 1,
		report: {
			asOfDate: '2026-09-03', today: '2026-09-03', balanceYi: 12,
			previousMonthBalanceYi: 10, previousYearBalanceYi: 8, liveBalanceYi: 12,
			balanceSnapshotDate: '2026-09-03',
			longBalanceYi: 7, shortBalanceYi: 5, cumulativeBorrowingYi: 2,
			parameters: {}, composition: [{ type: '公募债', amountYi: 12 }]
		},
		limits: []
	};
	const report = normalizeLiabilityReportDatabasePayload(payload, '2026-09-03');
	assert.equal(report.asOfDate, '2026-09-03');
	assert.equal(report.metrics.balanceMonthChangeYi, 2);
	assert.equal(report.metrics.longBalanceRatio, 7 / 12 * 100);
	assert.equal(report.quality.reconciliationComparable, true);
	assert.equal(report.quality.reconciliationDeltaYi, 0);
	assert.deepEqual(report.composition, [{ type: '公募债', amountYi: 12 }]);
	assert.throws(
		() => normalizeLiabilityReportDatabasePayload(payload, '2026-09-02'),
		/与所选日期 2026-09-02 不一致/
	);
});

test('balance reconciliation never compares report-date details with an older snapshot', () => {
	const report = normalizeLiabilityReportDatabasePayload({
		version: 1,
		report: {
			asOfDate: '2026-09-04', today: '2026-09-04', balanceYi: 12,
			previousMonthBalanceYi: 10, previousYearBalanceYi: 8, liveBalanceYi: 25,
			balanceSnapshotDate: '2026-09-03',
			longBalanceYi: 20, shortBalanceYi: 5, cumulativeBorrowingYi: 2,
			parameters: {}, composition: [{ type: '公募债', amountYi: 12 }]
		},
		limits: []
	}, '2026-09-04');
	const source = fs.readFileSync(new URL('../../src/lib/server/financing/liability-weekly-reports.js', import.meta.url), 'utf8');

	assert.equal(report.quality.reconciliationComparable, false);
	assert.equal(report.quality.reconciliationDeltaYi, null);
	assert.equal(report.quality.liveDerivedReliable, null);
	assert.match(source, /balanceSnapshotDate !== report\.asOfDate[\s\S]*code: 'balance_snapshot_date'[\s\S]*不执行跨日明细勾稽/);
	assert.match(source, /else if \(report\.quality\.liveDerivedReliable === false\)[\s\S]*code: 'reconciliation'/);
});

test('raw EDB observations are classified and broker-government spreads are calculated outside SQL', () => {
	const rawRows = [
		{ indicator_code: 'E1707781', observation_date: '2026-09-01', value: 2.11 },
		{ indicator_code: 'E1000172', observation_date: '2026-09-01', value: 1.71 },
		{ indicator_code: 'E1707781', observation_date: '2026-09-02', value: 2.15 },
		{ indicator_code: 'E1000172', observation_date: '2026-09-02', value: 1.7 },
		{ indicator_code: 'E1704284', observation_date: '2026-09-02', value: 1.82 }
	];
	const market = buildLiabilityMarketRateReport(rawRows, '2026-09-03');
	const spreads = market.marketHistory.filter((item) => item.seriesId === 'E1707781-E1000172');
	assert.deepEqual(spreads.map((item) => [item.observationDate, Math.round(item.value)]), [
		['2026-09-01', 40],
		['2026-09-02', 45]
	]);
	assert.equal(market.marketHistory.filter((item) => item.seriesId === 'E1707781').length, 4);
	assert.equal(market.marketObservations.find((item) => item.seriesId === 'E1707781-E1000172').observationDate, '2026-09-02');

	const payload = attachLiabilityMarketRates({
		version: 1,
		report: { asOfDate: '2026-09-03' },
		limits: []
	}, rawRows, '2026-09-03');
	assert.equal(payload.report.marketHistory.length, market.marketHistory.length);
	assert.equal(payload.report.marketRateError, null);
	const fallbackPayload = attachLiabilityMarketRates({
		version: 1,
		report: { asOfDate: '2026-09-03' },
		limits: []
	}, [], '2026-09-03', 'Data API schema cache unavailable');
	assert.deepEqual(fallbackPayload.report.marketHistory, []);
	assert.deepEqual(fallbackPayload.report.marketObservations, []);
	assert.equal(fallbackPayload.report.marketRateError, 'Data API schema cache unavailable');
	assert.throws(
		() => buildLiabilityMarketRateReport([{ indicator_code: 'UNKNOWN', observation_date: '2026-09-02', value: 1 }], '2026-09-03'),
		/不在周报白名单/
	);
	assert.throws(
		() => buildLiabilityMarketRateReport([{ indicator_code: 'E1707781', observation_date: '2025-12-31', value: 1 }], '2026-09-03'),
		/超出周报区间/
	);
});

test('Choice CTR failures are retried while the DM registration request remains independent', async () => {
	let calls = 0;
	const result = await fetchManualLiabilitySources({
		dataApiUrl: 'https://data.example/data', asOfDate: '2026-09-03',
		fetchImpl: async (url) => {
			calls += 1;
			return String(url).includes('/choice/ctr')
				? new Response('upstream failure', { status: 503 })
				: Response.json({ hasNextPage: false, rows: [] });
		},
		retryDelayMs: 0
	});
	assert.equal(calls, 4);
	assert.equal(result.ctr.status, 'missing');
	assert.equal(result.registration.status, 'available');
});

test('DM registration pages are exhausted before the report payload is saved', async () => {
	const registrationPages = [];
	const result = await fetchManualLiabilitySources({
		dataApiUrl: 'https://data.example/data', asOfDate: '2026-08-31',
		fetchImpl: async (url) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/choice/ctr')) return Response.json({ function: 'CTR', fields: CTR_INDICATOR_LIST, rows: [] });
			const pageNum = Number(parsed.searchParams.get('pageNum'));
			registrationPages.push(pageNum);
			return Response.json({
				hasNextPage: pageNum === 1,
				rows: [{
					projectName: `测试项目${pageNum}`, issuerName: '测试证券股份有限公司',
					status: '已受理', variety: '小公募', amountYi: pageNum,
					region: null, industry: '证券', leadUnderwriter: null,
					noticeNumber: null, venue: '上交所', registrationOrFiling: '注册',
					updateDate: '2026-09-02'
				}]
			});
		},
		retryDelayMs: 0
	});
	assert.deepEqual(registrationPages, [1, 2]);
	assert.equal(result.registration.pageCount, 2);
	assert.equal(result.registration.rows.length, 2);
});

test('weekly page renders the complete report directly in the workspace', () => {
	const source = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	assert.match(source, /近期负债发行与到期动态/);
	assert.match(source, /负债核心数据总览与指标监控/);
	assert.match(source, /融资额度及余额情况/);
	assert.match(source, /负债规模及利率走势/);
	assert.match(source, /负债到期分布全景/);
	assert.match(source, /可比券商申报及发行/);
	assert.match(source, /利率走势看板/);
	assert.match(source, /本周券商债券发行定价/);
	assert.match(source, /本周券商债券申报动态/);
	assert.match(source, /ReportBalanceRateChart/);
	assert.match(source, /ReportIssuanceChart/);
	assert.match(source, /ReportStackedBarChart/);
	assert.match(source, /ReportLineChart/);
	assert.match(source, /ReportGaugeChart/);
	assert.match(source, /ReportDonutChart/);
	assert.match(source, /ReportProgressChart/);
	assert.doesNotMatch(source, /<svg|<path|conic-gradient|progress-bar/);
	assert.doesNotMatch(source, /相关模块已隐藏数值/);
	assert.doesNotMatch(source, /近期动态暂不展示/);
	assert.doesNotMatch(source, /到期分布暂不展示/);
	assert.doesNotMatch(source, /class="weekly-report"/);
	assert.doesNotMatch(source, /id="reportContainer"/);
	assert.doesNotMatch(source, /class="a4-page"/);
	assert.doesNotMatch(source, /class="edit-toolbar"/);
	assert.equal((source.match(/class="report-page"/g) ?? []).length, 6);
	assert.equal((source.match(/第 \d+ 页 · 共 6 页/g) ?? []).length, 6);
	assert.doesNotMatch(source, /aria-label="数据口径"/);
	assert.doesNotMatch(source, /负债、融资计划与市场数据/);
	assert.doesNotMatch(source, /生产数据库口径/);
	assert.doesNotMatch(source, /近期动态口径/);
	assert.doesNotMatch(source, /详见第七部分/);
	assert.match(source, /emptyLiabilityWeeklyReport\(data\.selectedReportDate\)/);
	assert.match(source, /let hasSnapshot = \$derived\(Boolean\(data\.hasSnapshot\)\)/);
	assert.match(source, /item\.calculationMode === 'net_capital_60'[\s\S]*按上月末净资本×60%/);
	assert.match(source, /<td>\{approvalRule\(item\)\}<\/td>/);
	assert.match(source, /hasSnapshot \? amount\(compositionTotal\) : '数据缺失'/);
	assert.match(source, /sumEvents[\s\S]*hasSnapshot/);
	assert.match(source, /\{#if !hasSnapshot\}[\s\S]*暂无 \{data.selectedReportDate\} 负债周报/);
	assert.match(source, /\{#key data\.snapshotVersion\}/);
	assert.doesNotMatch(source, /数据缺失与来源状态|数据源：public\.edb ｜ 每日更新|历史周报快照/);
	assert.equal((source.match(/class="report-section"/g) ?? []).length, 7);
});

test('weekly report actions and report-date calendar stay in the application header', () => {
	const layout = fs.readFileSync(new URL('../../src/lib/financing/LiabilityReportActions.svelte', import.meta.url), 'utf8');
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	assert.match(layout, /report-header-actions/);
	assert.match(layout, /生成本期周报/);
	assert.match(layout, /window\.print\(\)/);
	assert.doesNotMatch(layout, /liability-report#history|历史快照/);
	assert.match(layout, /class="report-history-picker"/);
	assert.match(layout, /<label for="report-history-date">报告日<\/label>/);
	assert.match(layout, /<Input[\s\S]*type="date"[\s\S]*name="date"[\s\S]*value=\{selectedLiabilityReportDate\(\)\}/);
	assert.doesNotMatch(layout, /<select[\s\S]*liabilityReportHistory/);
	assert.doesNotMatch(page, /history-picker|report-history-date/);
});

test('weekly report preserves the 1080px desktop canvas when scaled to A4', () => {
	const layout = fs.readFileSync(new URL('../../src/routes/financing/+layout.svelte', import.meta.url), 'utf8');
	const layoutCss = fs.readFileSync(new URL('../../src/routes/financing/layout.css', import.meta.url), 'utf8');
	const reportCss = fs.readFileSync(new URL('../../src/routes/financing/liability-report/weekly-report.css', import.meta.url), 'utf8');
	assert.match(layout, /class:liability-report-content=\{isLiabilityReport\}/);
	assert.match(layoutCss, /\.financing-content\.liability-report-content\s*\{\s*max-width:\s*1080px/);
	assert.match(reportCss, /@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*0/);
	const printRules = reportCss.slice(reportCss.indexOf('@media print'));
	assert.match(printRules, /\.report-page\s*\{[\s\S]*width:\s*1080px !important/);
	assert.match(printRules, /height:\s*1527px !important/);
	assert.match(printRules, /zoom:\s*0\.734908136/);
	assert.match(reportCss, /break-after:\s*page/);
	assert.match(reportCss, /\.bento-footer/);
	assert.match(layoutCss, /\.tr-topbar[\s\S]*display: none !important/);
	const headerRules = reportCss.match(/\.bento-header\s*\{[^}]*\}/g) ?? [];
	assert.ok(headerRules.length >= 3);
	assert.ok(headerRules.every((rule) => !/min-height/.test(rule)));
});

test('optimized Neon report RPC supplies business chart data while raw EDB stays outside the function', () => {
	const migration = fs.readFileSync(new URL('../../financing-migrations/0020_optimize_liability_report_query.sql', import.meta.url), 'utf8');
	const queries = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION liability_weekly_report_data'));
	for (const field of ['maturityByType', 'annualMaturity', 'balanceRateTrend', 'issuanceTrend']) {
		assert.match(queries, new RegExp(`AS "${field}"`));
	}
	assert.match(queries, /jsonb_build_object\('type', type, 'amountYi', amount_yi\)/);
	assert.match(queries, /principal_yi/);
	assert.match(queries, /interest_yi/);
	assert.doesNotMatch(queries, /public\.edb|market_spread_history|marketHistory|marketObservations/);
	assert.match(migration, /CREATE VIEW financing\.liability_market_rate_observations/);
	assert.match(migration, /FROM public\.edb observation/);
	assert.match(migration, /GRANT SELECT ON financing\.liability_market_rate_observations TO authenticated/);
});

test('recent liability dynamics keep the agreed weekly exclusions while plans remain separate', () => {
	const queries = fs.readFileSync(new URL('../../financing-migrations/0020_optimize_liability_report_query.sql', import.meta.url), 'utf8');
	const eventRows = queries.slice(queries.indexOf('), event_rows AS'), queries.indexOf('), due_detail AS'));
	assert.equal((eventRows.match(/NOT IN \('同业拆借', '浮动收益凭证'\)/g) ?? []).length, 3);
	assert.equal((eventRows.match(/BETWEEN week\.week_start AND week\.as_of_date/g) ?? []).length, 3);
	assert.equal((eventRows.match(/BETWEEN week\.week_start \+ 7 AND week\.week_start \+ 11/g) ?? []).length, 3);
	assert.doesNotMatch(eventRows, /SELECT 'project'|project\.planned_issue_date/);
	assert.match(eventRows, /certificate\.subscription_date/);
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	assert.doesNotMatch(page, /sumEvents\(group\.items, \['issue', 'project'\]\)/);
	assert.match(page, /isDynamicEvent/);
	assert.match(page, /dynamicProjects as project/);
});

test('core maturity metrics include all arranged debt while only 30-day details apply exclusions', () => {
	const weeklyQuery = fs.readFileSync(new URL('../../financing-migrations/0020_optimize_liability_report_query.sql', import.meta.url), 'utf8');
	const scheduledMetrics = weeklyQuery.slice(weeklyQuery.indexOf('), scheduled_maturity_metrics AS'), weeklyQuery.indexOf('), largest_borrowing AS'));
	const dueDetails = weeklyQuery.slice(weeklyQuery.indexOf('), due_detail AS'), weeklyQuery.indexOf('), active_projects AS'));
	assert.match(scheduledMetrics, /FROM debt d CROSS JOIN latest/);
	assert.match(scheduledMetrics, /AS due_30_yi/);
	assert.match(scheduledMetrics, /AS due_year_yi/);
	assert.doesNotMatch(scheduledMetrics, /issue_date|NOT IN \('同业拆借', '浮动收益凭证'\)/);
	assert.match(dueDetails, /FROM debt d CROSS JOIN latest/);
	assert.equal((dueDetails.match(/NOT IN \('同业拆借', '浮动收益凭证'\)/g) ?? []).length, 1);
	assert.doesNotMatch(dueDetails, /cashflow_type = 'interest'|-利息/);
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	assert.match(page, /到期日 \{isoDate\(addDays\(report\.asOfDate, 30\)\)\} 前/);
	assert.match(page, /到期日 \{isoDate\(yearEnd\(report\.asOfDate\)\)\} 前/);
	assert.equal((page.match(/占主动负债/g) ?? []).length, 2);
	assert.doesNotMatch(page, /仅列负债本金到期；不含同业拆借及浮动收益凭证 ｜/);
	assert.doesNotMatch(page, /逐月到期堆叠柱状图|年度到期阶梯图/);
	assert.match(page, /<span class="badge-tag">单位：亿元<\/span>/);
	assert.doesNotMatch(page, /付息\/到期日|未来30天无到期或付息明细/);
});

test('generation publishes missing-data reminders through global system messages', () => {
	const layout = fs.readFileSync(new URL('../../src/lib/financing/LiabilityReportActions.svelte', import.meta.url), 'utf8');
	const server = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.server.ts', import.meta.url), 'utf8');
	assert.match(layout, /globalMessages\.warning\(/);
	assert.match(layout, /liability-report-missing-modules/);
	assert.match(layout, /本次周报有 \$\{notice\.missingModules\.length\} 项待核对/);
	assert.match(server, /missingModules: result\.missingModules/);
	assert.match(server, /snapshotVersion: result\.contentSha256/);
});

test('monitoring gauges use strong threshold colors and keep the value clear of the arc', () => {
	const chart = fs.readFileSync(new URL('../../src/charts/financing/ReportGaugeChart.svelte', import.meta.url), 'utf8');
	const progress = fs.readFileSync(new URL('../../src/charts/financing/ReportProgressChart.svelte', import.meta.url), 'utf8');
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	assert.match(chart, /type: 'gauge'/);
	assert.match(chart, /pointer:\s*\{[\s\S]*show: hasValue[\s\S]*length: '46%'/);
	assert.match(chart, /anchor:\s*\{[\s\S]*show: hasValue[\s\S]*borderColor: tone/);
	assert.match(chart, /shadowBlur: 6/);
	assert.match(chart, /\[Math\.min\(warning \/ chartMax, 1\), '#059669'\]/);
	assert.match(chart, /\[Math\.min\(limit \/ chartMax, 1\), '#d97706'\]/);
	assert.match(chart, /\[1, '#dc2626'\]/);
	assert.match(chart, /detail: \{ show: false \}/);
	assert.match(chart, /class="report-gauge-value"/);
	assert.match(chart, /\{#if hasValue\}/);
	assert.match(progress, /\{#if percent == null\}/);
	assert.ok(chart.indexOf('<EChart') < chart.indexOf('class="report-gauge-value"'));
	assert.doesNotMatch(chart, /progress:/);
	assert.match(chart, /stateLabel/);
	assert.match(chart, /tooltip:/);
	assert.doesNotMatch(chart, /decal|LinearGradient|RadialGradient/);
	assert.match(page, /gaugeState\(/);
	assert.match(page, /监管监控/);
});

test('weekly peer tables use current-week external APIs and remove imported staging tables', () => {
	const choice = fs.readFileSync(new URL('../../src/lib/financing/liability-choice.js', import.meta.url), 'utf8');
	const migration = fs.readFileSync(new URL('../../financing-migrations/0018_liability_report_data_api.sql', import.meta.url), 'utf8');
	const packageJson = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
	assert.match(choice, /ISSUERATE_REFERENCE/);
	assert.match(choice, /row\.issueDate >= weekWindow\.startDate/);
	assert.match(choice, /startDate: dateShift\(asOfDate, -daysSinceMonday\), endDate: asOfDate/);
	for (const table of ['liability_peer_issuances', 'liability_registration_progress', 'liability_market_observations']) {
		assert.match(migration, new RegExp(`DROP TABLE IF EXISTS ${table}`));
	}
	assert.doesNotMatch(packageJson, /db:import:weekly/);
	assert.equal(fs.existsSync(new URL('../../scripts/financing/import-liability-weekly-data.mjs', import.meta.url)), false);
});

test('weekly broker registrations continue in the right column after pricing', () => {
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	const css = fs.readFileSync(new URL('../../src/routes/financing/liability-report/weekly-report.css', import.meta.url), 'utf8');
	const peerSection = page.slice(page.indexOf('section-6-title'), page.indexOf('section-7-title'));
	assert.match(peerSection, /class="peer-columns"/);
	assert.match(page, /splitPeerRegistrations\(report\?\.registrationProgress/);
	assert.match(page, /rows\.slice\(0, leftCount\), rows\.slice\(leftCount\)/);
	assert.match(peerSection, /本周券商债券申报动态（续表）/);
	assert.match(peerSection, /peerRegistrationColumns\[1\]\?\.length/);
	assert.match(page, /peerRegistrationTable/);
	assert.match(page, /brokerShortName\(item\.issuerName\)/);
	assert.ok(peerSection.indexOf('本周券商债券发行定价') < peerSection.indexOf('本周券商债券申报动态'));
	assert.match(css, /\.peer-columns\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*align-items:\s*start/);
	assert.match(css, /@media \(max-width:\s*64rem\)[\s\S]*\.peer-columns\s*\{\s*grid-template-columns:\s*1fr/);
	assert.match(css, /\.peer-column\s*\{[^}]*align-content:\s*start/);
	assert.doesNotMatch(css, /column-count|column-fill/);
});

test('weekly report core cards use the requested comparison and maturity labels', () => {
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	const core = page.slice(page.indexOf('section-2-title'), page.indexOf('class="p1-gauge-row"'));
	assert.doesNotMatch(core, /periodEnd\)\}口径|发行期限口径|金额覆盖|起息与到期字段覆盖/);
	assert.match(core, /weightedRateMonthBp/);
	assert.match(core, /weightedRateYearBp/);
	assert.match(core, /remainingMonthChangeDays/);
	assert.match(core, /remainingYearChangeDays/);
	assert.match(core, /长期 <b>[\s\S]*<br \/>短期 <b>/);
});

test('all weekly report tables and quota progress charts size to their available columns without scrollbars', () => {
	const css = fs.readFileSync(new URL('../../src/routes/financing/liability-report/weekly-report.css', import.meta.url), 'utf8');
	assert.match(css, /\.table-scroll\s*\{[^}]*overflow:\s*visible/);
	assert.match(css, /\.bento-table\s*\{[\s\S]*table-layout:\s*auto/);
	assert.match(css, /\.quota-progress\s*\{[^}]*width:\s*clamp\(/);
	assert.match(css, /\.quota-progress\s*\{[^}]*min-width:\s*0/);
	assert.doesNotMatch(css, /overflow-x:\s*auto|min-width:\s*(?:32|47|58|9)rem|table-layout:\s*fixed/);
});

test('all liability report charts use the shared ECharts host instead of hand-drawn markup', () => {
	const chartFiles = [
		'ReportBalanceRateChart.svelte', 'ReportIssuanceChart.svelte', 'ReportLineChart.svelte',
		'ReportStackedBarChart.svelte', 'ReportGaugeChart.svelte', 'ReportDonutChart.svelte',
		'ReportProgressChart.svelte'
	];
	for (const file of chartFiles) {
		const source = fs.readFileSync(new URL(`../../src/charts/financing/${file}`, import.meta.url), 'utf8');
		assert.match(source, /ChartHost/);
		assert.doesNotMatch(source, /<svg|<path|<rect|conic-gradient/);
		assert.doesNotMatch(source, /decal:\s*\{\s*show:\s*true/);
	}
	const charting = fs.readFileSync(new URL('../../src/charts/charting.ts', import.meta.url), 'utf8');
	assert.match(charting, /from ['"]echarts\/core['"]/);
	assert.match(charting, /GaugeChart/);
	assert.match(charting, /PieChart/);
	assert.match(charting, /MarkPointComponent/);
});

test('liability charts and optimized Neon RPC follow the report chart contract', () => {
	const balance = fs.readFileSync(new URL('../../src/charts/financing/ReportBalanceRateChart.svelte', import.meta.url), 'utf8');
	const issuance = fs.readFileSync(new URL('../../src/charts/financing/ReportIssuanceChart.svelte', import.meta.url), 'utf8');
	const stacked = fs.readFileSync(new URL('../../src/charts/financing/ReportStackedBarChart.svelte', import.meta.url), 'utf8');
	const chartTypes = fs.readFileSync(new URL('../../src/charts/financing/report.ts', import.meta.url), 'utf8');
	const page = fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.svelte', import.meta.url), 'utf8');
	const queries = fs.readFileSync(new URL('../../financing-migrations/0020_optimize_liability_report_query.sql', import.meta.url), 'utf8');
	const choice = fs.readFileSync(new URL('../../src/lib/financing/liability-choice.js', import.meta.url), 'utf8');

	assert.match(balance, /areaStyle:/);
	assert.match(balance, /firstIndexOfEachYear/);
	assert.match(balance, /markPoint:/);
	assert.match(balance, /value\.slice\(0, 4\)/);
	assert.match(chartTypes, /\['短融', '3年公募债', '5年公募债', '3年次级债', '5年次级债'\]/);
	assert.match(issuance, /\.\.\.issuanceTrendTypes\.map\(\(type\) => \(\{/);
	assert.match(issuance, /data:\s*\[\.\.\.issuanceTrendTypes\]/);
	assert.match(issuance, /params\.dataIndex === lastRateIndices\[type\]/);
	assert.match(issuance, /Number\(row\.amountYi\) > 0 \|\| row\.weightedRatePct != null/);
	assert.match(issuance, /connectNulls:\s*true/);
	assert.doesNotMatch(issuance, /data:\s*\[[^\]]*加权发行利率/);

	assert.match(stacked, /position:\s*'inside'/);
	assert.match(stacked, /maximum:\s*\{\s*color:\s*'#dc2626'/);
	assert.match(stacked, /inverse:\s*true/);
	assert.match(stacked, /isHighlighted/);
	assert.match(page, /highlightLabel="东方财富"/);
	assert.match(page, /sort\(\(a, b\) => b\[1\] - a\[1\]\)/);

	assert.match(queries, /CREATE TABLE financing\.monthly_financing_metrics/);
	assert.match(queries, /SELECT financing\.refresh_monthly_financing_metrics/);
	assert.match(queries, /cached_balance_rate_trend AS/);
	assert.match(queries, /FROM monthly_financing_metrics metrics/);
	assert.match(queries, /current_balance_rate_trend AS/);
	assert.doesNotMatch(queries.slice(queries.indexOf('CREATE OR REPLACE FUNCTION liability_weekly_report_data')), /trend_months AS|SELECT LEAST\(/);
	assert.match(queries, /classified_issuances AS/);
	assert.match(queries, /issuance_types\(type\) AS/);
	assert.match(queries, /FROM issuance_months CROSS JOIN issuance_types/);
	assert.match(queries, /THEN '3年公募债'/);
	assert.match(queries, /THEN '5年次级债'/);
	assert.match(choice, /originalTermYears <= 1 \? '短期公司债' : '公募债'/);
	assert.match(queries, /CREATE VIEW financing\.liability_market_rate_observations/);
	assert.doesNotMatch(queries.slice(queries.indexOf('CREATE OR REPLACE FUNCTION liability_weekly_report_data')), /raw_market_history AS|market_spread_history/);
});

test('page load never fetches quota-limited Choice sources and the browser owns the manual CTR request', () => {
	const [page, layout, service] = [
		fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.server.ts', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/LiabilityReportActions.svelte', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/server/financing/liability-weekly-reports.js', import.meta.url), 'utf8')
	];
	assert.doesNotMatch(page, /fetchManualLiabilitySources/);
	assert.doesNotMatch(service, /fetchManualLiabilitySources|CHOICE_DATA_API_URL/);
	assert.match(layout, /fetchManualLiabilitySources/);
	assert.match(layout, /broker-bond-registrations|reportSourcesPayload/);
	assert.match(layout, /dataApiUrl/);
	assert.match(layout, /liability-report\?\/saveSnapshot/);
	assert.match(page, /saveSnapshot:[\s\S]*saveLiabilityWeeklyReportSnapshot/);
	assert.doesNotMatch(page, /generateLiabilityWeeklyReport|generate:/);
});

test('liability market rates come from scheduled public.edb data, not manual Choice EDB', () => {
	const [service, choice, page, layout, client, reportData] = [
		fs.readFileSync(new URL('../../src/lib/server/financing/liability-weekly-reports.js', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/liability-choice.js', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.server.ts', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/LiabilityReportActions.svelte', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/neon-data-api.ts', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/liability-report-data.js', import.meta.url), 'utf8')
	];
	assert.match(service, /public\.edb/);
	assert.match(service, /edbLogicalRequests: 0/);
	assert.match(service, /spreadCalculation: 'browser'/);
	assert.match(choice, /PEER_BOND_TYPES/);
	assert.match(choice, /\/broker-bond-registrations/);
	assert.match(service, /manualSources\.registration\.status === 'available'/);
	assert.match(service, /registrationProgress: manualSources\.registration\.status/);
	assert.match(service, /path: '\/broker-bond-registrations'/);
	assert.match(client, /liability_market_rate_observations/);
	assert.match(layout, /const marketRatesRequest = neonDataApi\.liabilityMarketRates\(asOfDate\)\.then\(/);
	assert.match(layout, /rows: \[\],[\s\S]*error: String\(error\?\.message \?\? error\)\.slice\(0, 500\)/);
	assert.match(layout, /attachLiabilityMarketRates\([\s\S]*marketRatesResult\.rows,[\s\S]*marketRatesResult\.error/);
	assert.match(reportData, /value: \(item\.value - governmentValue\) \* 100/);
	assert.doesNotMatch(choice, /\/choice\/edb|edbIds/);
	assert.doesNotMatch(page, /\/choice\/edb|edbIds/);
});

test('weekly report snapshots overwrite the existing eastmoney liability-report key by date', () => {
	const service = fs.readFileSync(new URL('../../src/lib/server/financing/liability-weekly-reports.js', import.meta.url), 'utf8');
	const config = fs.readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
	assert.match(service, /liability-report\/\$\{asOfDate\}\.json/);
	assert.match(service, /WHERE as_of_date = \?/);
	assert.match(service, /missing_maturity_details/);
	assert.match(config, /"bucket_name": "eastmoney"/);
});

test('importer has a migration-era swap identity fallback', () => {
	const source = fs.readFileSync(new URL('../../src/lib/server/financing/debt-importer.js', import.meta.url), 'utf8');
	assert.match(source, /source\.debt_type = '互换便利'/);
	assert.match(source, /existing\.maturity_date IS NOT DISTINCT FROM source\.maturity_date/);
});
