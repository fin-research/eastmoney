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

	assert.equal(report.quality.reconciliationComparable, false);
	assert.equal(report.quality.reconciliationDeltaYi, null);
	assert.equal(report.quality.liveDerivedReliable, null);
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
});

test('page load never fetches quota-limited Choice sources and the browser owns the manual CTR request', () => {
	const [page, layout, choice, service] = [
		fs.readFileSync(new URL('../../src/routes/financing/liability-report/+page.server.ts', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/LiabilityReportActions.svelte', import.meta.url), 'utf8'),
		fs.readFileSync(new URL('../../src/lib/financing/liability-choice.js', import.meta.url), 'utf8'),
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
