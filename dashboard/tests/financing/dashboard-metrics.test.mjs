import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
	SHORT_DEBT_MAX_ORIGINAL_TERM_DAYS,
	currentYearBorrowingPredicateSql,
	projectAmountYiForTypes,
	reportingTypeSql,
	selectedDebtTypePredicateSql,
	shortDebtPredicateSql
} from '../../src/lib/server/financing/dashboard-metrics.js';

test('short debt uses original issuance term and only the three business instrument groups', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await db.exec(`
		CREATE TABLE debt (
			debt_type text NOT NULL,
			subtype text,
			amount numeric NOT NULL,
			issue_date date,
			maturity_date date,
			term_days integer
		);
		INSERT INTO debt VALUES
			('收益凭证', '浮动收益凭证', 10, '2025-08-22', '2026-08-22', 365),
			('收益凭证', '浮动收益凭证', 20, '2025-08-21', '2026-08-22', 366),
			('收益凭证', '固定收益凭证', 30, '2025-08-22', '2026-08-22', 365),
			('收益凭证', '固定收益凭证', 40, '2025-08-21', '2026-08-23', 367),
			('债券', '短期融资券', 50, '2024-01-01', NULL, NULL),
			('同业拆借', NULL, 70, '2026-08-01', NULL, NULL),
			('债券', '小公募', 60, '2023-01-01', '2026-12-31', 1460),
			('集团借款', NULL, 80, '2026-01-01', '2026-12-31', 364),
			('债券', '短期公司债', 110, '2026-08-01', '2027-08-01', 365),
			('转融资', NULL, 120, '2026-08-01', '2027-02-01', NULL),
			('收益凭证', '固定收益凭证', 90, '2025-08-20', '2026-08-20', 365),
			('同业拆借', NULL, 100, '2026-08-22', '2026-08-23', 1);
	`);
	const result = await db.query(`
		WITH latest(as_of_date) AS (VALUES (DATE '2026-08-21')),
		current_debt AS (
			SELECT d.* FROM debt d CROSS JOIN latest
			WHERE (d.issue_date IS NULL OR d.issue_date <= latest.as_of_date)
				AND (d.maturity_date IS NULL OR d.maturity_date > latest.as_of_date)
		)
		SELECT COALESCE(SUM(d.amount) FILTER (WHERE ${shortDebtPredicateSql('d')}), 0) AS amount
		FROM current_debt d
	`);

	assert.equal(SHORT_DEBT_MAX_ORIGINAL_TERM_DAYS, 365);
	assert.equal(reportingTypeSql('d'), "COALESCE(NULLIF(d.subtype, ''), d.debt_type)");
	assert.equal(Number(result.rows[0].amount), 160);
});

test('largest new borrowing only considers issues from the as-of calendar year', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await db.exec(`
		CREATE TABLE debt (amount numeric NOT NULL, issue_date date);
		INSERT INTO debt VALUES
			(57.8, '2025-12-31'),
			(30, '2026-01-01'),
			(40, '2026-08-20'),
			(100, '2026-08-22'),
			(200, NULL);
	`);
	const result = await db.query(`
		WITH latest(as_of_date) AS (VALUES (DATE '2026-08-21'))
		SELECT COALESCE(MAX(d.amount) FILTER (
			WHERE ${currentYearBorrowingPredicateSql('d', 'latest.as_of_date')}
		), 0) AS amount
		FROM debt d CROSS JOIN latest
	`);

	assert.equal(Number(result.rows[0].amount), 40);
});

test('dashboard type selection filters cumulative borrowing snapshots', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await db.exec(`
		CREATE TABLE balance_snapshot (
			as_of_date date NOT NULL,
			debt_type text NOT NULL,
			subtype text,
			amount numeric NOT NULL
		);
		INSERT INTO balance_snapshot VALUES
			('2025-12-31', '债券', '短期融资券', 100),
			('2025-12-31', '债券', '小公募', 200),
			('2026-07-31', '债券', '短期融资券', 150),
			('2026-07-31', '债券', '小公募', 260);
	`);
	const cumulativeFor = async (selectedTypesSql) => {
		const result = await db.query(`
			WITH args(selected_types) AS (VALUES (${selectedTypesSql})),
			periods(label, as_of_date) AS (
				VALUES ('current', DATE '2026-07-31'), ('previous', DATE '2025-12-31')
			)
			SELECT periods.label, COALESCE(SUM(b.amount) FILTER (
				WHERE ${selectedDebtTypePredicateSql('b')}
			), 0) AS amount
			FROM periods CROSS JOIN args
			LEFT JOIN balance_snapshot b ON b.as_of_date = periods.as_of_date
			GROUP BY periods.label
		`);
		const balances = Object.fromEntries(result.rows.map((row) => [row.label, Number(row.amount)]));
		return balances.current - balances.previous;
	};

	assert.equal(await cumulativeFor("ARRAY['短期融资券']::text[]"), 50);
	assert.equal(await cumulativeFor('ARRAY[]::text[]'), 110);
});

test('project KPI follows dashboard types while the project table remains complete', async () => {
	const projects = [
		{ debtType: '小公募', amountYi: 10 },
		{ debtType: '短期融资券', amountYi: 20 },
		{ debtType: '同业拆借', amountYi: null }
	];
	assert.equal(projectAmountYiForTypes(projects), 30);
	assert.equal(projectAmountYiForTypes(projects, ['小公募']), 10);

	const [queries, page] = await Promise.all([
		readFile(new URL('../../src/lib/server/financing/queries.js', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/+page.svelte', import.meta.url), 'utf8')
	]);
	const activeProjects = queries.slice(queries.indexOf('), active_projects AS ('), queries.indexOf('), issue_months AS ('));
	assert.doesNotMatch(activeProjects, /selected_types|CROSS JOIN args/);
	assert.match(activeProjects, /NULLIF\(BTRIM\(p\.tenor_description\), ''\)/);
	assert.doesNotMatch(activeProjects, /COALESCE\(p\.notes,/);
	assert.match(activeProjects, /p\.funding_cost_rate/);
	assert.match(queries, /'cost', cost/);
	assert.match(page, /projectTableAmountYi = \$derived\(dashboard\.projects\.reduce/);
	assert.match(page, /\{projectTableAmountYi\.toFixed\(2\)\}/);
});

test('dashboard metric cards keep an isolated two-row, three-column layout with equal rows', async () => {
	const [page, styles] = await Promise.all([
		readFile(new URL('../../src/routes/financing/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/dashboard.css', import.meta.url), 'utf8')
	]);

	assert.match(page, /<section class="financing-metric-grid" aria-label="融资指标">/);
	assert.match(page, /<MetricCard label=\{metric\.label\}/);
	assert.doesNotMatch(page, /financing-metric-card/);
	assert.match(styles, /\.financing-metric-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?grid-auto-rows:\s*minmax\(10rem,\s*1fr\);/);
	assert.doesNotMatch(page, /class="metric-grid"|class={`metric-card/);
});
