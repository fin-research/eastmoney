// @ts-nocheck
import { getDirectory } from '../directory.ts';
import { REPORTING_DEBT_TYPES } from '../../financing/debt-types.js';
import { reminderPeriodLabel } from '../../financing/reminder-periods.js';
import {
	currentYearBorrowingPredicateSql,
	projectAmountYiForTypes,
	reportingTypeSql,
	selectedDebtTypePredicateSql,
	shortDebtPredicateSql
} from './dashboard-metrics.js';
import { getDatabase } from './db.js';
import { loadDebtDetail } from './debt-detail.js';

const number = (value) => Number(value ?? 0);
const REPORTING_TYPE_SQL = reportingTypeSql;

function addUtcDays(date, days) {
	const value = new Date(`${date}T00:00:00Z`);
	value.setUTCDate(value.getUTCDate() + days);
	return value.toISOString().slice(0, 10);
}

function dateInShanghai() {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
	}).format(new Date());
}

function endOfPreviousMonth(date) {
	const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
	value.setUTCDate(0);
	return value.toISOString().slice(0, 10);
}

function financeParameters(value) {
	return Object.fromEntries(Object.entries(value ?? {}).map(([code, item]) => [code, {
		...item,
		valueYi: item?.valueYi == null ? null : number(item.valueYi)
	}]));
}

function debtTone(type) {
	if (type === '收益凭证') return 'violet';
	if (type === '短期融资券') return 'teal';
	if (type === '同业拆借') return 'orange';
	return 'blue';
}

export function getDebtTypeOptions() {
	return [...REPORTING_DEBT_TYPES];
}

/** @param {{ selectedTypes?: string[] }} [options] */
export async function getFinancingDashboardData({ selectedTypes = [] } = {}) {
	const db = getDatabase();
	const today = dateInShanghai();
	const overview = await db.prepare(`
		WITH args AS (
			SELECT ?::text[] AS selected_types, ?::date AS today
		), latest AS (
			SELECT COALESCE(MAX(as_of_date), (SELECT today FROM args)) AS as_of_date
			FROM balance_snapshot
		), dates AS (
			SELECT 'current'::text AS label, as_of_date FROM latest
			UNION ALL SELECT 'month', (date_trunc('month', as_of_date)::date - 1) FROM latest
			UNION ALL SELECT 'year', make_date(EXTRACT(YEAR FROM as_of_date)::integer - 1, 12, 31) FROM latest
		), point_detail AS (
			SELECT dates.label,
				COALESCE(SUM(d.amount), 0) / 100000000.0 AS balance_yi,
				COALESCE(SUM(d.amount * d.annual_rate) FILTER (WHERE d.annual_rate IS NOT NULL)
					/ NULLIF(SUM(d.amount) FILTER (WHERE d.annual_rate IS NOT NULL), 0), 0) AS weighted_rate,
				COALESCE(SUM(d.amount * GREATEST(d.maturity_date - dates.as_of_date, 0)) FILTER (WHERE d.maturity_date IS NOT NULL)
					/ NULLIF(SUM(d.amount) FILTER (WHERE d.maturity_date IS NOT NULL), 0), 0) AS weighted_days
			FROM dates
			CROSS JOIN args
			LEFT JOIN debt d ON (d.issue_date IS NULL OR d.issue_date <= dates.as_of_date)
				AND (d.maturity_date IS NULL OR d.maturity_date > dates.as_of_date)
				AND ${selectedDebtTypePredicateSql()}
			GROUP BY dates.label
		), snapshot_dates AS (
			SELECT dates.label, MAX(b.as_of_date) AS as_of_date
			FROM dates LEFT JOIN balance_snapshot b ON b.as_of_date <= dates.as_of_date
			GROUP BY dates.label
		), snapshot_totals AS (
			SELECT snapshot_dates.label, COALESCE(SUM(b.amount), 0) / 100000000.0 AS balance_yi
			FROM snapshot_dates
			LEFT JOIN balance_snapshot b ON b.as_of_date = snapshot_dates.as_of_date
			GROUP BY snapshot_dates.label
		), current_debt AS (
			SELECT d.* FROM debt d CROSS JOIN latest CROSS JOIN args
			WHERE (d.issue_date IS NULL OR d.issue_date <= latest.as_of_date)
				AND (d.maturity_date IS NULL OR d.maturity_date > latest.as_of_date)
				AND ${selectedDebtTypePredicateSql()}
		), composition AS (
			SELECT CASE WHEN debt_type = '收益凭证' THEN debt_type ELSE COALESCE(NULLIF(subtype, ''), debt_type) END AS type,
				SUM(amount) / 100000000.0 AS amount_yi
			FROM current_debt GROUP BY 1 ORDER BY amount_yi DESC, type
		), months AS (
			SELECT to_char(date_trunc('month', (SELECT today FROM args)) + (value || ' months')::interval, 'YYYY-MM') AS month
			FROM generate_series(0, 5) AS series(value)
		), maturity AS (
			SELECT to_char(maturity_date, 'YYYY-MM') AS month, SUM(amount) / 100000000.0 AS amount_yi
			FROM current_debt WHERE maturity_date IS NOT NULL GROUP BY 1
		), due_30 AS (
			SELECT COALESCE(SUM(value), 0) / 100000000.0 AS amount_yi
			FROM (
				SELECT d.amount + d.interest_payable AS value
				FROM current_debt d CROSS JOIN args
				WHERE d.maturity_date > args.today AND d.maturity_date <= args.today + 30
				UNION ALL
				SELECT COALESCE(c.amount, 0)
				FROM cashflow c JOIN current_debt d ON d.id = c.debt_id CROSS JOIN args
				WHERE c.cashflow_type = 'interest' AND c.due_date > args.today AND c.due_date <= args.today + 30
					AND (d.maturity_date IS NULL OR d.maturity_date <> c.due_date)
			) values_due
		), active_projects AS (
			SELECT p.id, p.name, p.debt_type, p.borrower AS counterparty, p.amount,
				COALESCE(NULLIF(BTRIM(p.tenor_description), ''), CASE WHEN p.planned_maturity_date IS NOT NULL AND p.planned_issue_date IS NOT NULL
					THEN ROUND((p.planned_maturity_date - p.planned_issue_date) / 365.0, 1)::text || 'Y' ELSE '待定' END) AS tenor,
				CASE WHEN p.funding_cost_rate IS NULL THEN '待定'
					ELSE to_char(p.funding_cost_rate * 100, 'FM999990.00') || '%' END AS cost,
				p.planned_issue_date, p.status
			FROM projects p
			WHERE p.status IN ('planning', 'in_progress', 'at_risk')
		), issue_months AS (
			SELECT to_char(date_trunc('month', latest.as_of_date) - interval '1 month', 'YYYY-MM') AS current_month,
				to_char(date_trunc('month', latest.as_of_date) - interval '1 year 1 month', 'YYYY-MM') AS comparison_month
			FROM latest
		), issuance_labels(label, reporting_type) AS (
			VALUES ('公募次级', '次级债'), ('小公募', '小公募'), ('私募债', '私募债'), ('短融', '短期融资券')
		), issuance AS (
			SELECT labels.label,
				COALESCE(SUM(d.amount) FILTER (WHERE to_char(d.issue_date, 'YYYY-MM') = months.current_month), 0) / 100000000.0 AS current_yi,
				COALESCE(SUM(d.amount) FILTER (WHERE to_char(d.issue_date, 'YYYY-MM') = months.comparison_month), 0) / 100000000.0 AS comparison_yi
			FROM issuance_labels labels CROSS JOIN issue_months months
			LEFT JOIN debt d ON ${REPORTING_TYPE_SQL()} = labels.reporting_type
			GROUP BY labels.label
		), parameter_map AS (
			SELECT COALESCE(jsonb_object_agg(code, jsonb_build_object(
				'label', label, 'valueYi', value_yi, 'periodEnd', period_end, 'notes', notes
			)), '{}'::jsonb) AS value
			FROM financing.finance_parameters_as_of((SELECT as_of_date FROM latest))
		), borrowing AS (
			SELECT COALESCE(MAX(d.amount) FILTER (
					WHERE ${currentYearBorrowingPredicateSql()}
				), 0) / 100000000.0 AS largest_yi,
				COALESCE(SUM(d.amount) FILTER (
					WHERE (d.maturity_date IS NULL OR d.maturity_date > latest.as_of_date)
						AND ${shortDebtPredicateSql()}
				), 0) / 100000000.0 AS short_debt_yi
			FROM debt d CROSS JOIN latest CROSS JOIN args
			WHERE (d.issue_date IS NULL OR d.issue_date <= latest.as_of_date)
				AND ${selectedDebtTypePredicateSql()}
		), completed_month AS (
			SELECT date_trunc('month', latest.as_of_date)::date - 1 AS as_of_date FROM latest
		), completed_balance AS (
			SELECT COALESCE(SUM(b.amount) FILTER (
					WHERE ${selectedDebtTypePredicateSql('b')}
				), 0) / 100000000.0 AS balance_yi, MAX(b.as_of_date) AS as_of_date
			FROM balance_snapshot b CROSS JOIN completed_month CROSS JOIN args
			WHERE b.as_of_date = (SELECT MAX(as_of_date) FROM balance_snapshot WHERE as_of_date <= completed_month.as_of_date)
		), previous_year_balance AS (
			SELECT COALESCE(SUM(b.amount) FILTER (
					WHERE ${selectedDebtTypePredicateSql('b')}
				), 0) / 100000000.0 AS balance_yi
			FROM balance_snapshot b CROSS JOIN latest CROSS JOIN args
			WHERE b.as_of_date = (SELECT MAX(as_of_date) FROM balance_snapshot WHERE as_of_date <= make_date(EXTRACT(YEAR FROM latest.as_of_date)::integer - 1, 12, 31))
		)
		SELECT latest.as_of_date AS asOfDate,
			CASE WHEN cardinality(args.selected_types) = 0
				THEN (SELECT balance_yi FROM snapshot_totals WHERE label = 'current')
				ELSE (SELECT balance_yi FROM point_detail WHERE label = 'current') END AS balanceYi,
			CASE WHEN cardinality(args.selected_types) = 0
				THEN (SELECT balance_yi FROM snapshot_totals WHERE label = 'month')
				ELSE (SELECT balance_yi FROM point_detail WHERE label = 'month') END AS previousMonthBalanceYi,
			CASE WHEN cardinality(args.selected_types) = 0
				THEN (SELECT balance_yi FROM snapshot_totals WHERE label = 'year')
				ELSE (SELECT balance_yi FROM point_detail WHERE label = 'year') END AS previousYearBalanceYi,
			(SELECT weighted_rate FROM point_detail WHERE label = 'current') AS weightedRate,
			(SELECT weighted_rate FROM point_detail WHERE label = 'month') AS previousMonthRate,
			(SELECT weighted_rate FROM point_detail WHERE label = 'year') AS previousYearRate,
			(SELECT weighted_days FROM point_detail WHERE label = 'current') AS weightedDays,
			(SELECT weighted_days FROM point_detail WHERE label = 'month') AS previousMonthDays,
			(SELECT weighted_days FROM point_detail WHERE label = 'year') AS previousYearDays,
			(SELECT amount_yi FROM due_30) AS due30Yi,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('type', type, 'amountYi', amount_yi) ORDER BY amount_yi DESC) FROM composition), '[]'::jsonb) AS composition,
			(SELECT jsonb_agg(jsonb_build_object('month', months.month, 'amountYi', COALESCE(maturity.amount_yi, 0)) ORDER BY months.month)
				FROM months LEFT JOIN maturity USING (month)) AS maturityDistribution,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'debtType', debt_type,
				'counterparty', COALESCE(counterparty, '/'), 'amountYi', amount / 100000000.0, 'tenor', tenor,
				'cost', cost, 'landingDate', planned_issue_date, 'status', status) ORDER BY planned_issue_date, name)
				FROM active_projects), '[]'::jsonb) AS projects,
			(SELECT jsonb_build_object('currentMonth', current_month, 'comparisonMonth', comparison_month,
				'rows', (SELECT jsonb_agg(jsonb_build_object('label', label, 'currentYi', current_yi, 'comparisonYi', comparison_yi) ORDER BY label) FROM issuance))
				FROM issue_months) AS monthlyIssuance,
			(SELECT value FROM parameter_map) AS parameters,
			(SELECT largest_yi FROM borrowing) AS largestBorrowingYi,
			(SELECT short_debt_yi FROM borrowing) AS shortDebtYi,
			(SELECT balance_yi FROM completed_balance) - (SELECT balance_yi FROM previous_year_balance) AS cumulativeBorrowingYi,
			(SELECT as_of_date FROM completed_balance) AS cumulativeBorrowingDate
		FROM latest CROSS JOIN args
	`).get(selectedTypes, today);

	const [limitData, events] = await Promise.all([
		getDebtLimitSummary(db),
		getCalendarMonthEvents(db, today)
	]);
	const parameters = financeParameters(overview.parameters);
	const projects = (overview.projects ?? []).map((item) => ({ ...item, amountYi: number(item.amountYi) }));
	const securitiesNetAssets = parameters.securities_prior_year_net_assets?.valueYi;
	const groupNetAssets = parameters.group_prior_year_net_assets?.valueYi;
	const netCapital = parameters.prior_month_net_capital?.valueYi;
	const ratio = (numerator, denominator) => denominator ? number(numerator) / denominator * 100 : null;
	const balanceYi = number(overview.balanceYi);
	const previousMonthBalanceYi = number(overview.previousMonthBalanceYi);
	const previousYearBalanceYi = number(overview.previousYearBalanceYi);
	const weightedRate = number(overview.weightedRate);
	const previousMonthRate = number(overview.previousMonthRate);
	const previousYearRate = number(overview.previousYearRate);
	const weightedDays = number(overview.weightedDays);
	const previousMonthDays = number(overview.previousMonthDays);
	const previousYearDays = number(overview.previousYearDays);
	const cumulativeBorrowingYi = number(overview.cumulativeBorrowingYi);

	return {
		asOfDate: overview.asOfDate ?? today,
		today,
		selectedTypes,
		typeOptions: getDebtTypeOptions(),
		calendarMonth: today.slice(0, 7),
		events,
		metrics: {
			balanceYi,
			balanceMonthChangeYi: balanceYi - previousMonthBalanceYi,
			balanceYearChangeYi: balanceYi - previousYearBalanceYi,
			weightedRatePct: weightedRate * 100,
			weightedRateMonthBp: (weightedRate - previousMonthRate) * 10000,
			weightedRateYearBp: (weightedRate - previousYearRate) * 10000,
			weightedRemainingDays: weightedDays,
			remainingMonthChangeDays: weightedDays - previousMonthDays,
			remainingYearChangeDays: weightedDays - previousYearDays,
			due30Yi: number(overview.due30Yi),
			projectAmountYi: projectAmountYiForTypes(projects, selectedTypes),
			shortDebtRatio: ratio(overview.shortDebtYi, netCapital),
			largestBorrowingRatio: ratio(overview.largestBorrowingYi, securitiesNetAssets),
			cumulativeSecuritiesRatio: ratio(cumulativeBorrowingYi, securitiesNetAssets),
			cumulativeGroupRatio: ratio(cumulativeBorrowingYi, groupNetAssets),
			shortDebtYi: number(overview.shortDebtYi),
			largestBorrowingYi: number(overview.largestBorrowingYi),
			cumulativeBorrowingYi,
			cumulativeBorrowingDate: overview.cumulativeBorrowingDate ?? endOfPreviousMonth(overview.asOfDate ?? today)
		},
		parameters,
		composition: (overview.composition ?? []).map((item) => ({ ...item, amountYi: number(item.amountYi) })),
		maturityDistribution: (overview.maturityDistribution ?? []).map((item) => ({ ...item, amountYi: number(item.amountYi) })),
		projects,
		monthlyIssuance: {
			...overview.monthlyIssuance,
			rows: (overview.monthlyIssuance?.rows ?? []).map((item) => ({
				...item, currentYi: number(item.currentYi), comparisonYi: number(item.comparisonYi)
			}))
		},
		...limitData
	};
}

export async function getProjectGanttData(filters = {}) {
	const db = getDatabase();
	const rows = await db.prepare(`
		SELECT p.id, p.code, p.name, p.debt_type AS debtType, p.status,
			p.planned_start_date AS plannedStartDate, p.planned_issue_date AS plannedIssueDate,
			p.planned_maturity_date AS plannedMaturityDate, p.amount, p.notes,
			p.expected_rate_min AS expectedRateMin, p.expected_rate_max AS expectedRateMax,
			p.funding_cost_rate AS fundingCostRate, p.tenor_description AS tenorDescription,
			p.amount_description AS amountDescription,
			p.owner_id AS ownerId,
			pt.id AS taskId, pt.name AS taskName, pt.status AS taskStatus,
			pt.schedule_type AS taskScheduleType,
			CASE WHEN pt.schedule_type = 'period' THEN pt.planned_start_date END AS taskPlannedStartDate, pt.due_date AS taskDueDate,
			pt.completed_at AS taskCompletedAt, pt.sort_order AS taskSortOrder,
			pt.assignee_id AS taskAssigneeId
		FROM projects p
		LEFT JOIN project_tasks pt ON pt.project_id = p.id
		WHERE (?::text IS NULL OR p.id = ?)
			AND (?::text IS NULL OR p.debt_type = ?)
			AND (?::text IS NULL OR p.owner_id = ? OR EXISTS (
				SELECT 1 FROM project_tasks scoped
				WHERE scoped.project_id = p.id AND scoped.assignee_id = ?
			))
			AND (?::text IS NULL OR p.status = ?)
		ORDER BY COALESCE(p.planned_start_date, p.planned_issue_date), p.name, pt.sort_order, pt.due_date
	`).all(
		filters.projectId ?? null, filters.projectId ?? null,
		filters.debtType ?? null, filters.debtType ?? null,
		filters.personId ?? null, filters.personId ?? null, filters.personId ?? null,
		filters.status ?? null, filters.status ?? null
	);
	const people = new Map((await getDirectory().people()).map(person => [person.id, person]));
	const projects = new Map();
	for (const row of rows) {
		if (!projects.has(row.id)) {
			projects.set(row.id, {
				id: row.id, code: row.code, name: row.name, debtType: row.debtType, status: row.status,
				plannedStartDate: row.plannedStartDate, plannedIssueDate: row.plannedIssueDate,
				plannedMaturityDate: row.plannedMaturityDate, amount: row.amount == null ? null : number(row.amount),
				expectedRateMin: row.expectedRateMin == null ? null : number(row.expectedRateMin),
				expectedRateMax: row.expectedRateMax == null ? null : number(row.expectedRateMax),
				fundingCostRate: row.fundingCostRate == null ? null : number(row.fundingCostRate),
				tenorDescription: row.tenorDescription, amountDescription: row.amountDescription,
				ownerId: row.ownerId, ownerName: people.get(row.ownerId)?.name ?? (row.ownerId ? '已移除账号' : null), notes: row.notes,
				tasks: []
			});
		}
		if (row.taskId) projects.get(row.id).tasks.push({
			id: row.taskId, name: row.taskName, status: row.taskStatus,
			scheduleType: row.taskScheduleType, plannedStartDate: row.taskPlannedStartDate, dueDate: row.taskDueDate,
			completedAt: row.taskCompletedAt, sortOrder: row.taskSortOrder,
			assigneeName: people.get(row.taskAssigneeId)?.name ?? (row.taskAssigneeId ? '已移除账号' : null)
		});
	}
	return { filters, projects: [...projects.values()] };
}

export async function getProjectFormOptions(database = getDatabase()) {
 const projectSops = await database.prepare(`SELECT id, name, debt_type AS debtType FROM sop_templates WHERE is_active = TRUE ORDER BY debt_type, name, id`).all();
 return { people: (await getDirectory().people()).filter(person => person.active), projectSops };
}

export async function getDebtLimitSummary(database = getDatabase()) {
	const today = dateInShanghai();
	const rows = await database.prepare(`
		WITH latest AS (
			SELECT COALESCE(MAX(as_of_date), ?::date) AS as_of_date FROM balance_snapshot
		), net_capital AS (
			SELECT value_yi, period_end FROM financing.finance_parameters_as_of((SELECT as_of_date FROM latest)) WHERE code = 'prior_month_net_capital'
		), usage AS (
			SELECT config.debt_type,
				CASE WHEN config.usage_basis = 'since_approval' THEN (
					SELECT COALESCE(SUM(d.amount), 0) / 100000000.0 FROM debt d CROSS JOIN latest
					WHERE ${REPORTING_TYPE_SQL()} = CASE WHEN config.debt_type = '公募次级' THEN '次级债' ELSE config.debt_type END
						AND d.issue_date >= COALESCE(config.approved_date, DATE '0001-01-01')
						AND d.issue_date <= latest.as_of_date
				) ELSE (
					SELECT COALESCE(SUM(snapshot.amount), 0) / 100000000.0
					FROM balance_snapshot snapshot CROSS JOIN latest
					WHERE snapshot.as_of_date = latest.as_of_date
						AND (snapshot.debt_type = config.debt_type
							OR NULLIF(snapshot.subtype, '') = CASE WHEN config.debt_type = '公募次级' THEN '次级债' ELSE config.debt_type END)
				) END AS issued_yi
			FROM debt_limit_configs config
		)
		SELECT config.debt_type AS debtType,
			CASE WHEN config.calculation_mode = 'net_capital_60' AND net.value_yi IS NOT NULL
				THEN net.value_yi * 0.6 ELSE config.limit_yi END AS limitYi,
			config.limit_yi AS configuredLimitYi, usage.issued_yi AS issuedYi,
			CASE WHEN config.calculation_mode = 'net_capital_60' AND net.value_yi IS NOT NULL
				THEN net.value_yi * 0.6 ELSE config.limit_yi END - usage.issued_yi AS remainingYi,
			config.usage_basis AS usageBasis, config.approved_date AS approvedDate,
			config.expiry_date AS expiryDate, config.calculation_mode AS calculationMode,
			config.sort_order AS sortOrder,
			(config.calculation_mode = 'net_capital_60' AND (net.period_end IS NULL OR net.period_end < date_trunc('month', ?::date)::date - 1)) AS needsNetCapitalUpdate
		FROM debt_limit_configs config JOIN usage USING (debt_type) LEFT JOIN net_capital net ON TRUE
		ORDER BY config.sort_order, config.debt_type
	`).all(today, today);
	const limits = rows.map((item) => ({
		...item,
		limitYi: number(item.limitYi), configuredLimitYi: number(item.configuredLimitYi),
		issuedYi: number(item.issuedYi), remainingYi: number(item.remainingYi),
		needsNetCapitalUpdate: Boolean(item.needsNetCapitalUpdate)
	}));
	const limitTotals = limits.reduce((total, item) => ({
		limitYi: total.limitYi + item.limitYi,
		issuedYi: total.issuedYi + item.issuedYi,
		remainingYi: total.remainingYi + item.remainingYi
	}), { limitYi: 0, issuedYi: 0, remainingYi: 0 });
	return {
		limits,
		limitTotals,
		financeParameterReminder: limits.some((item) => item.needsNetCapitalUpdate)
	};
}

export async function getCalendarMonthEvents(database = getDatabase(), today = dateInShanghai()) {
	const monthStart = `${today.slice(0, 7)}-01`;
	const nextMonth = new Date(`${monthStart}T00:00:00Z`);
	nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
	const monthEnd = addUtcDays(nextMonth.toISOString().slice(0, 10), -1);
	const rows = await database.prepare(`
		WITH interest AS (
			SELECT debt_id, due_date, SUM(amount) AS amount
			FROM cashflow WHERE cashflow_type = 'interest' AND due_date BETWEEN ? AND ?
			GROUP BY debt_id, due_date
		), events AS (
			SELECT 'maturity'::text AS kind, d.id::text AS id, d.id AS debt_id, d.maturity_date AS date,
				d.debt_type, ${REPORTING_TYPE_SQL()} AS filter_type, d.name AS short_name,
				(d.amount + COALESCE(interest.amount, d.interest_payable, 0)) / 100000000.0 AS amount_yi
			FROM debt d LEFT JOIN interest ON interest.debt_id = d.id AND interest.due_date = d.maturity_date
			WHERE d.maturity_date BETWEEN ? AND ? AND d.closed_at IS NULL
			UNION ALL
			SELECT 'interest', (c.debt_id::text || ':' || c.sequence::text), d.id, c.due_date,
				d.debt_type, ${REPORTING_TYPE_SQL()}, d.name,
				COALESCE(c.amount, 0) / 100000000.0
			FROM cashflow c JOIN debt d ON d.id = c.debt_id
			WHERE c.cashflow_type = 'interest' AND c.due_date BETWEEN ? AND ?
				AND (d.maturity_date IS NULL OR d.maturity_date <> c.due_date)
			UNION ALL
			SELECT 'project', p.id, NULL::bigint, p.planned_issue_date, p.debt_type, p.debt_type, p.name,
				COALESCE(p.amount, 0) / 100000000.0
			FROM projects p WHERE p.status IN ('planning', 'in_progress', 'at_risk')
				AND p.planned_issue_date BETWEEN ? AND ?
		)
		SELECT kind, id, debt_id AS debtId, date, debt_type AS debtType,
			filter_type AS filterType, short_name AS shortName, amount_yi AS amountYi
		FROM events ORDER BY date, short_name, kind
	`).all(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);
	return rows.map((row) => {
		const amountYi = number(row.amountYi);
		if (row.kind === 'project') return {
			id: `project:${row.id}`, date: row.date, debtType: row.debtType, filterType: row.filterType,
			shortName: row.shortName, tone: 'blue',
			title: `${row.shortName}•簿记发行${amountYi ? ` ${amountYi.toFixed(2)}亿元` : ''}`,
			href: `/projects/${row.id}`, amountYi
		};
		return {
			id: `${row.kind}:${row.id}`, debtId: row.debtId, date: row.date,
			debtType: row.debtType, filterType: row.filterType, shortName: row.shortName,
			tone: row.kind === 'interest' ? 'orange' : debtTone(row.filterType),
			title: row.kind === 'interest'
				? `${row.shortName}•付息 ${amountYi.toFixed(2)}亿元`
				: `${row.shortName}•到期本息 ${amountYi.toFixed(2)}亿元`,
			href: `/debts/${row.debtId}`, amountYi
		};
	});
}

export async function getDebtDetail(id) {
  if (!/^\d+$/.test(String(id))) return null;
  return loadDebtDetail(getDatabase(), id);
}

export async function getWorkflowSettingsData() {
	const db = getDatabase();
	const result = await db.prepare(`
		SELECT COALESCE((
			SELECT jsonb_agg(jsonb_build_object(
				'id', st.id, 'name', st.name, 'debtType', st.debt_type,
				'description', st.description, 'isActive', st.is_active,
				'nodeCount', (SELECT COUNT(*) FROM sop_nodes sn WHERE sn.template_id = st.id),
				'nodes', COALESCE((
					SELECT jsonb_agg(jsonb_build_object(
						'id', sn.id, 'name', sn.name, 'sortOrder', sn.sort_order
					) ORDER BY sn.sort_order, sn.created_at, sn.id)
					FROM sop_nodes sn WHERE sn.template_id = st.id
				), '[]'::jsonb)
			) ORDER BY st.debt_type, st.name)
			FROM sop_templates st
		), '[]'::jsonb) AS sopTemplates,
		COALESCE((
			SELECT jsonb_agg(jsonb_build_object(
				'id', rule.id, 'name', rule.name,
				'channel', rule.channel, 'recipientMode', rule.recipient_mode,
				'recipients', rule.recipients, 'isActive', rule.is_active,
				'targets', COALESCE((
					SELECT jsonb_agg(jsonb_build_object(
						'id', node.id, 'name', node.name, 'sopId', template.id,
						'sopName', template.name, 'debtType', template.debt_type
					) ORDER BY template.debt_type, template.name, node.sort_order, node.created_at, node.id)
					FROM reminder_rule_nodes target
					JOIN sop_nodes node ON node.id = target.sop_node_id
					JOIN sop_templates template ON template.id = node.template_id
					WHERE target.rule_id = rule.id
				), '[]'::jsonb),
				'periods', COALESCE((
					SELECT jsonb_agg(jsonb_build_object(
						'id', period.id, 'leadHours', period.lead_hours,
						'sortOrder', period.sort_order
					) ORDER BY period.sort_order, period.id)
					FROM reminder_rule_periods period WHERE period.rule_id = rule.id
				), '[]'::jsonb)
			) ORDER BY rule.is_active DESC, rule.name)
			FROM reminder_rules rule
		), '[]'::jsonb) AS reminderRules
	`).get();
	const sopTemplates = result.sopTemplates ?? [];
	const reminderRules = result.reminderRules ?? [];
	return {
		sopTemplates: sopTemplates.map((item) => ({
			...item,
			isActive: Boolean(item.isActive),
			nodeCount: number(item.nodeCount),
			nodes: item.nodes ?? []
		})),
		reminderRules: reminderRules.map((item) => ({
			...item,
			isActive: Boolean(item.isActive),
			targets: item.targets ?? [],
			periods: (item.periods ?? []).map((period) => ({ ...period, leadHours: number(period.leadHours) }))
		}))
	};
}

const SOP_EVENT_DEBT_TYPE_SCOPE = { 公司债: ['公司债', '小公募', '私募债', '次级债'] };

async function getActiveSopEventDebtTypes(db) {
	const activeTypes = await db.prepare(`
		SELECT DISTINCT debt_type AS debtType FROM sop_templates WHERE is_active = TRUE
	`).all();
	return [...new Set(activeTypes.flatMap(({ debtType }) => SOP_EVENT_DEBT_TYPE_SCOPE[debtType] ?? [debtType]))];
}

export async function getActiveSopDebtTypeOptions() {
	return getActiveSopEventDebtTypes(getDatabase());
}

/** @param {{ today: string, toDate: string, personId?: string | null, ownOnly?: boolean, limit?: number }} options */
export async function getLayoutData({ today, toDate, personId = null, ownOnly = false, limit = 10 }) {
	const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 30);
	const result = await getDatabase().prepare(`
		WITH reminders AS (
		SELECT pt.id, pt.name AS taskName, pt.status, pt.due_date AS dueDate,
			p.id AS projectId, p.name AS projectName, p.debt_type AS debtType,
			pt.assignee_id AS assigneeId, COUNT(*) OVER() AS totalCount
		FROM project_tasks pt
		JOIN projects p ON p.id = pt.project_id
		JOIN sop_templates st ON st.id = p.sop_template_id AND st.is_active = TRUE
		WHERE pt.status <> 'completed' AND p.status NOT IN ('completed', 'cancelled')
			AND pt.due_date IS NOT NULL AND pt.due_date <= @toDate
			AND (@ownOnly::boolean = FALSE OR pt.assignee_id = @personId OR p.owner_id = @personId)
		ORDER BY CASE WHEN pt.status = 'blocked' THEN 0 WHEN pt.due_date < @today THEN 1
			WHEN pt.due_date = @today THEN 2 ELSE 3 END, pt.due_date, p.name, pt.sort_order
		LIMIT @limit
		)
		SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
				'id', id, 'taskName', taskname, 'status', status, 'dueDate', duedate,
				'projectId', projectid, 'projectName', projectname, 'debtType', debttype,
				'assigneeId', assigneeid, 'totalCount', totalcount
			) ORDER BY CASE WHEN status = 'blocked' THEN 0 WHEN duedate < @today THEN 1
				WHEN duedate = @today THEN 2 ELSE 3 END, duedate, projectname, id
			) FROM reminders), '[]'::jsonb) AS reminders
	`).get({ today, toDate, personId, ownOnly: Boolean(ownOnly && personId), limit: safeLimit });
	const people = new Map((await getDirectory().people()).map(person => [person.id, person]));
	const rows = result.reminders ?? [];
	const items = rows.map((item) => {
		const dueDays = Math.round((Date.parse(`${item.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
		const isDanger = item.status === 'blocked' || dueDays < 0;
		const dueLabel = item.status === 'blocked' ? '节点阻塞'
			: dueDays < 0 ? `逾期 ${Math.abs(dueDays)} 天`
				: dueDays === 0 ? '今天到期' : dueDays === 1 ? '明天到期' : `${dueDays} 天后到期`;
		return {
			id: item.id, projectId: item.projectId, projectName: item.projectName,
			taskName: item.taskName, debtType: item.debtType, assigneeName: people.get(item.assigneeId)?.name ?? (item.assigneeId ? '已移除账号' : null),
			dueDate: item.dueDate, dueLabel, level: isDanger ? 'danger' : dueDays <= 1 ? 'warning' : 'info',
			href: `/projects/${item.projectId}`
		};
	});
	return {
		reminders: { items, total: rows.length ? number(rows[0].totalCount) : 0 }
	};
}

function decodeReminderCursor(cursor) {
	if (!cursor || String(cursor).length > 1000) return null;
	try {
		const [deliveryDate, createdAt, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
		const parsedDate = Date.parse(`${deliveryDate}T00:00:00Z`);
		const parsedCreatedAt = Date.parse(String(createdAt));
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) ||
			!Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== deliveryDate ||
			!Number.isFinite(parsedCreatedAt) || !id || String(id).length > 200
		) return null;
		return { deliveryDate, createdAt: String(createdAt), id: String(id) };
	} catch {
		return null;
	}
}

function encodeReminderCursor(row) {
	return Buffer.from(JSON.stringify([row.deliveryDate, row.createdAt, row.id])).toString('base64url');
}

/** @param {{ status?: string | null, query?: string | null, cursor?: string | null, limit?: number, includeSummary?: boolean, database?: ReturnType<typeof getDatabase> }} [options] */
export async function getReminderHistory({ status, query, cursor, limit = 50, includeSummary = true, database = getDatabase() } = {}) {
	const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
	const validStatus = status && ['pending', 'queued', 'sent', 'failed'].includes(status) ? status : null;
	const safeQuery = String(query ?? '').trim().slice(0, 160);
	const decodedCursor = decodeReminderCursor(cursor);
	const summaryCte = includeSummary ? `,
		summary AS (
			SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'sent') AS sent,
				COUNT(*) FILTER (WHERE status IN ('pending','queued')) AS pending,
				COUNT(*) FILTER (WHERE status = 'failed') AS failed
			FROM reminder_deliveries
		)` : '';
	const summarySelect = includeSummary
		? ', to_jsonb(summary) AS summary FROM summary'
		: ', NULL::jsonb AS summary';
	const result = await database.prepare(`
		WITH filtered AS (
			SELECT rd.id, rd.delivery_date AS deliveryDate, rd.target_type AS targetType,
				rd.scheduled_for AS scheduledFor, rd.target_id AS targetId, rd.recipients, rd.status,
				rd.provider_message_id AS providerMessageId, rd.error_message AS errorMessage,
				rd.created_at AS createdAt, rd.sent_at AS sentAt, rr.name AS ruleName,
				period.lead_hours AS leadHours
			FROM reminder_deliveries rd
			JOIN reminder_rules rr ON rr.id = rd.rule_id
			JOIN reminder_rule_periods period ON period.id = rd.period_id AND period.rule_id = rd.rule_id
			WHERE (?::text IS NULL OR rd.status = ?)
				AND (?::text IS NULL OR rr.name ILIKE ? OR rd.target_id ILIKE ?
					OR rd.recipients::text ILIKE ? OR COALESCE(rd.error_message, '') ILIKE ?)
				AND (?::date IS NULL OR (rd.delivery_date, rd.created_at, rd.id) < (?::date, ?::timestamptz, ?::text))
			ORDER BY rd.delivery_date DESC, rd.created_at DESC, rd.id DESC LIMIT ?
		)${summaryCte}
		SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
			'id', id, 'deliveryDate', deliverydate, 'scheduledFor', scheduledfor, 'targetType', targettype,
			'targetId', targetid, 'recipients', recipients, 'status', status,
			'providerMessageId', providermessageid, 'errorMessage', errormessage,
			'createdAt', createdat, 'sentAt', sentat, 'ruleName', rulename, 'leadHours', leadhours
		) ORDER BY deliverydate DESC, createdat DESC, id DESC) FROM filtered), '[]'::jsonb) AS rows
			${summarySelect}
	`).get(
		validStatus, validStatus,
		safeQuery || null, safeQuery ? `%${safeQuery}%` : null, safeQuery ? `%${safeQuery}%` : null,
		safeQuery ? `%${safeQuery}%` : null, safeQuery ? `%${safeQuery}%` : null,
		decodedCursor?.deliveryDate ?? null, decodedCursor?.deliveryDate ?? null,
		decodedCursor?.createdAt ?? null, decodedCursor?.id ?? null, safeLimit + 1
	);
	const fetchedRows = result.rows ?? [];
	const hasMore = fetchedRows.length > safeLimit;
	const pageRows = fetchedRows.slice(0, safeLimit);
	return {
		rows: pageRows.map((row) => ({
			...row,
			leadHours: number(row.leadHours),
			periodLabel: reminderPeriodLabel(number(row.leadHours)),
			recipients: Array.isArray(row.recipients) ? row.recipients : []
		})),
		hasMore,
		nextCursor: hasMore && pageRows.length ? encodeReminderCursor(pageRows.at(-1)) : null,
		summary: {
			total: number(result.summary?.total), sent: number(result.summary?.sent),
			pending: number(result.summary?.pending), failed: number(result.summary?.failed)
		}
	};
}
