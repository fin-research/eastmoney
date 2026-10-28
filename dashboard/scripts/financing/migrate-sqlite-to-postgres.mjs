import { financingTimestamp } from '../../src/lib/financing/time.js';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from 'pg';
import { normalizeIncomeCertificateName, previousWorkingDay } from './lib/debt-transform.mjs';

const sourceArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const sourcePath = path.resolve(sourceArgument ?? 'database/financing-workbench.sqlite');
const connectionString = process.env.DATABASE_URL;
const dryRun = process.argv.includes('--dry-run');
if (!connectionString && !dryRun) throw new Error('缺少 DATABASE_URL；迁移脚本必须从本地直连 Neon');

const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });
const client = new Client({ connectionString, application_name: 'eastmoney-financing-sqlite-migration' });
const BOND_TYPES = new Set(['小公募', '私募债', '次级债', '短期融资券', '科创债', '公司债']);

function rows(table) {
	const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	return exists ? sqlite.prepare(`SELECT * FROM ${table}`).all() : [];
}

function byKey(table, key = 'debt_id') {
	return new Map(rows(table).map((row) => [row[key], row]));
}

function parseJson(value, fallback = null) {
	if (value == null || value === '') return fallback;
	if (typeof value !== 'string') return value;
	try { return JSON.parse(value); } catch { return fallback; }
}

function boolean(value) {
	if (value == null || value === '') return null;
	if (typeof value === 'boolean') return value;
	return ['1', 'true', 'yes', 'y', '是', '已'].includes(String(value).trim().toLowerCase());
}

function nonnegative(value) {
	const number = Number(value ?? 0);
	return Number.isFinite(number) ? Math.max(number, 0) : 0;
}

function shortDate(value) {
	return value ? String(value).slice(0, 10) : null;
}

function isoDate(value) {
	const match = String(value ?? '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ T])/);
	if (!match) return null;
	return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

async function bulkUpsert(table, columns, sourceRows, conflictColumns, updateColumns = columns.map(([name]) => name)) {
	if (!sourceRows.length) return 0;
	const columnNames = columns.map(([name]) => name);
	const updates = updateColumns.filter((name) => !conflictColumns.includes(name));
	await client.query(`
		INSERT INTO financing.${table} (${columnNames.join(', ')})
		SELECT ${columnNames.join(', ')}
		FROM jsonb_to_recordset($1::jsonb) AS source(${columns.map(([name, type]) => `${name} ${type}`).join(', ')})
		ON CONFLICT (${conflictColumns.join(', ')}) ${updates.length
			? `DO UPDATE SET ${updates.map((name) => `${name} = EXCLUDED.${name}`).join(', ')}`
			: 'DO NOTHING'}
	`, [JSON.stringify(sourceRows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value != null && columns.some(([name, type]) => name === key && /timestamp/.test(type)) ? financingTimestamp(value) : value]))))]);
	return sourceRows.length;
}

async function migrateWorkflowTables() {
	const migrated = {};
	const authUsers = rows('auth_users');
	const avatarByPerson = new Map(authUsers.map((user) => [user.person_id, user.avatar_data_url ?? null]));
	const people = rows('people').map((row) => ({ ...row, active: Boolean(row.active), avatar_data_url: avatarByPerson.get(row.id) ?? null }));
	migrated.people = await bulkUpsert('people', [
		['id', 'text'], ['name', 'text'], ['email', 'text'], ['role', 'text'], ['active', 'boolean'],
		['avatar_data_url', 'text'],
		['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], people, ['id']);
	migrated.skippedLegacyAuthAccounts = authUsers.length;

	migrated.sopTemplates = await bulkUpsert('sop_templates', [
		['id', 'text'], ['name', 'text'], ['debt_type', 'text'], ['description', 'text'], ['is_active', 'boolean'],
		['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], rows('sop_templates').map((row) => ({ ...row, is_active: Boolean(row.is_active) })), ['id']);
	migrated.sopNodes = await bulkUpsert('sop_nodes', [
		['id', 'text'], ['template_id', 'text'], ['name', 'text'], ['description', 'text'], ['sort_order', 'integer'],
		['default_offset_days', 'integer'], ['default_owner_role', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], rows('sop_nodes'), ['id']);
	migrated.projects = await bulkUpsert('projects', [
		['id', 'text'], ['code', 'text'], ['name', 'text'], ['debt_type', 'text'], ['borrower', 'text'],
		['amount', 'numeric'], ['currency', 'text'], ['status', 'text'], ['planned_start_date', 'date'],
		['planned_issue_date', 'date'], ['planned_maturity_date', 'date'], ['sop_template_id', 'text'],
		['owner_id', 'text'], ['notes', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], rows('projects'), ['id']);
	migrated.projectTasks = await bulkUpsert('project_tasks', [
		['id', 'text'], ['project_id', 'text'], ['sop_node_id', 'text'], ['name', 'text'], ['status', 'text'],
		['assignee_id', 'text'], ['planned_start_date', 'date'], ['due_date', 'date'], ['completed_at', 'timestamptz'],
		['sort_order', 'integer'], ['notes', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], rows('project_tasks'), ['id']);

	migrated.skippedLegacyReminderRules = rows('reminder_rules').length;
	migrated.skippedLegacyReminderDeliveries = rows('reminder_deliveries').length;
	migrated.financeParameters = await bulkUpsert('finance_parameters', [
		['code', 'text'], ['label', 'text'], ['value_yi', 'numeric'], ['period_end', 'date'], ['notes', 'text'],
		['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], rows('finance_parameters'), ['code']);
	await client.query(`
		INSERT INTO financing.financial_monthly_data (
			period_end, net_capital, securities_net_assets, group_net_assets,
			total_assets, total_liabilities, agency_brokerage_funds, notes
		)
		SELECT (date_trunc('month', period_end) + INTERVAL '1 month - 1 day')::date,
			MAX(value_yi) FILTER (WHERE code = 'prior_month_net_capital'),
			MAX(value_yi) FILTER (WHERE code = 'securities_prior_year_net_assets'),
			MAX(value_yi) FILTER (WHERE code = 'group_prior_year_net_assets'),
			MAX(value_yi) FILTER (WHERE code = 'total_assets'),
			MAX(value_yi) FILTER (WHERE code = 'total_liabilities'),
			MAX(value_yi) FILTER (WHERE code = 'agency_brokerage_funds'),
			string_agg(label || '：' || notes, E'\\n' ORDER BY code) FILTER (WHERE notes IS NOT NULL)
		FROM financing.finance_parameters
		WHERE value_yi IS NOT NULL AND period_end IS NOT NULL AND code IN (
			'prior_month_net_capital', 'securities_prior_year_net_assets', 'group_prior_year_net_assets',
			'total_assets', 'total_liabilities', 'agency_brokerage_funds'
		)
		GROUP BY (date_trunc('month', period_end) + INTERVAL '1 month - 1 day')::date
		ON CONFLICT (period_end) DO NOTHING
	`);
	migrated.debtLimits = await bulkUpsert('debt_limit_configs', [
		['debt_type', 'text'], ['limit_yi', 'numeric'], ['usage_basis', 'text'], ['approved_date', 'date'],
		['expiry_date', 'date'], ['calculation_mode', 'text'], ['sort_order', 'integer'],
		['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], rows('debt_limit_configs'), ['debt_type']);

	const personByUser = new Map(authUsers.map((user) => [user.id, user.person_id]));
	const emailByUser = new Map(authUsers.map((user) => [user.id, people.find((person) => person.id === user.person_id)?.email ?? null]));
	migrated.auditLogs = await bulkUpsert('audit_logs', [
		['id', 'text'], ['actor_person_id', 'text'], ['actor_email', 'text'], ['action', 'text'], ['entity_type', 'text'],
		['entity_id', 'text'], ['summary', 'text'], ['before_json', 'jsonb'], ['after_json', 'jsonb'],
		['request_ip', 'inet'], ['user_agent', 'text'], ['created_at', 'timestamptz']
	], rows('audit_logs').map((row) => ({
		id: row.id, actor_person_id: personByUser.get(row.actor_user_id) ?? null, actor_email: emailByUser.get(row.actor_user_id) ?? null,
		action: row.action, entity_type: row.entity_type, entity_id: row.entity_id, summary: row.summary,
		before_json: parseJson(row.before_json), after_json: parseJson(row.after_json),
		request_ip: row.request_ip || null, user_agent: row.user_agent, created_at: row.created_at
	})), ['id']);
	return migrated;
}

function makeDebtRows(idByOldId) {
	const bond = byKey('bond_debt_details');
	const certificate = byKey('income_certificate_details');
	const incomeRight = byKey('income_right_details');
	const interbank = byKey('interbank_borrowing_details');
	const refinancing = byKey('refinancing_details');
	const group = byKey('group_loan_details');
	const swap = byKey('swap_facility_details');
	const groupInterest = new Map();
	for (const schedule of rows('group_loan_schedules')) {
		const unpaid = Math.max(Number(schedule.accrued_interest_amount ?? 0) - Number(schedule.paid_interest_amount ?? 0), 0);
		groupInterest.set(schedule.debt_id, (groupInterest.get(schedule.debt_id) ?? 0) + unpaid);
	}

	return rows('debts').map((source) => {
		const isBond = BOND_TYPES.has(source.debt_type);
		const details = isBond ? bond.get(source.id)
			: source.debt_type === '收益凭证' ? certificate.get(source.id)
				: source.debt_type === '收益权转让' ? incomeRight.get(source.id)
					: source.debt_type === '同业拆借' ? interbank.get(source.id)
						: source.debt_type === '转融资' ? refinancing.get(source.id)
							: source.debt_type === '集团借款' ? group.get(source.id)
								: source.debt_type === '互换便利' ? swap.get(source.id) : null;
		const debtType = isBond ? '债券' : source.debt_type;
		const subtype = isBond ? source.debt_type
			: source.debt_type === '收益凭证' ? (source.category_level_2 || '固定收益凭证') : null;
		const counterparty = source.debt_type === '收益凭证' ? details?.investor_type || source.counterparty
			: source.debt_type === '集团借款' ? details?.lender_name || source.counterparty : source.counterparty;
		const name = isBond ? details?.short_name || source.instrument_name || source.instrument_code
			: source.debt_type === '收益凭证' ? normalizeIncomeCertificateName(details?.product_name || source.instrument_name || details?.series_name)
				: source.debt_type === '收益权转让' ? details?.period_label
					: source.debt_type === '同业拆借' ? `同业拆借·${counterparty || '未登记对手'}·${source.issue_date || '未定期'}`
						: source.debt_type === '转融资' ? '转融资'
							: source.debt_type === '集团借款' ? `集团借款·${counterparty || '未登记对手'}·${source.issue_date || '未定期'}`
								: source.debt_type === '互换便利' ? `互换便利·${details?.first_repo_date || source.issue_date || '未定期'}`
									: source.instrument_name;
		const interestPayable = isBond ? details?.stated_interest_amount
			: source.debt_type === '收益凭证' ? details?.interest_amount
				: source.debt_type === '收益权转让' ? details?.stated_interest_amount
					: source.debt_type === '同业拆借' ? details?.interest_amount
						: source.debt_type === '转融资' ? details?.interest_amount
							: source.debt_type === '集团借款' ? groupInterest.get(source.id) : 0;
		const issueDate = isoDate(source.issue_date);
		const redemptionDate = source.debt_type === '收益凭证' ? isoDate(details?.redemption_date) : null;
		const maturityDate = isoDate(source.maturity_date) ?? previousWorkingDay(redemptionDate);
		const lifecycleDate = issueDate || shortDate(source.created_at);
		return {
			table: isBond ? 'bond'
				: source.debt_type === '收益凭证' ? 'income_certificate'
					: source.debt_type === '收益权转让' ? 'income_right'
						: source.debt_type === '转融资' ? 'refinancing'
							: source.debt_type === '互换便利' ? 'swap_facility' : 'debt',
			id: idByOldId.get(source.id), debt_type: debtType, subtype,
			name: name || `${source.debt_type}·${source.issue_date || idByOldId.get(source.id)}`,
			counterparty: counterparty || null,
			amount: nonnegative(source.outstanding_amount ?? source.principal_amount),
			interest_payable: nonnegative(interestPayable), annual_rate: source.annual_rate,
			issue_date: issueDate, maturity_date: maturityDate,
			activated_at: source.status === 'planned' ? null : lifecycleDate,
			settled_at: source.status === 'matured' ? (maturityDate || lifecycleDate) : null,
			closed_at: source.status === 'closed' ? (maturityDate || lifecycleDate) : null,
			created_at: source.created_at, updated_at: source.updated_at,
			extension: isBond ? {
				issuance_method: details?.issuance_method, bookbuilding_date: isoDate(details?.bookbuilding_date),
				interest_basis: details?.interest_basis, issuance_target: details?.issuance_target,
				market: details?.market, receiving_account: details?.receiving_account,
				trustee: details?.trustee, bookrunner: details?.bookrunner
			} : source.debt_type === '收益凭证' ? {
				liquidation_submission_status: details?.liquidation_submission_status,
				liquidation_registration_status: details?.liquidation_registration_status,
				return_type: details?.return_type, subscription_date: isoDate(details?.subscription_date),
				redemption_date: redemptionDate, receiving_account: details?.receiving_account,
				early_maturity: boolean(details?.is_early_maturity)
			} : source.debt_type === '收益权转让' ? { interest_basis_days: details?.interest_basis_days }
				: source.debt_type === '转融资' ? {
					interest_basis_days: details?.interest_basis_days, market: details?.market,
					is_extended: boolean(details?.is_extended), receiving_account: details?.receiving_account,
					repayment_account: details?.repayment_account
				} : source.debt_type === '互换便利' ? {
					average_repo_balance_description: details?.average_repo_balance_description,
					repo_weighted_average_rate: details?.repo_weighted_average_rate
				} : {}
		};
	});
}

async function migrateDebts() {
	const destination = await client.query('SELECT COUNT(*)::integer AS count FROM financing.debt');
	if (destination.rows[0].count !== 0) throw new Error('financing.debt 已有数据；为避免重复或覆盖，本迁移脚本只允许迁入空负债库');
	await client.query("SELECT setval('financing.debt_id_seq', 1, false)");
	const sourceDebts = rows('debts');
	const allocated = sourceDebts.length
		? (await client.query("SELECT nextval('financing.debt_id_seq') AS id FROM generate_series(1, $1::integer)", [sourceDebts.length])).rows
		: [];
	const idByOldId = new Map(sourceDebts.map((debt, index) => [debt.id, Number(allocated[index].id)]));
	const debtRows = makeDebtRows(idByOldId);
	const common = [
		['id', 'bigint'], ['debt_type', 'text'], ['subtype', 'text'], ['name', 'text'],
		['counterparty', 'text'], ['amount', 'numeric'], ['interest_payable', 'numeric'], ['annual_rate', 'numeric'],
		['issue_date', 'date'], ['maturity_date', 'date'], ['activated_at', 'date'], ['settled_at', 'date'], ['closed_at', 'date'],
		['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	];
	const extensions = {
		debt: [],
		bond: [['issuance_method', 'text'], ['bookbuilding_date', 'date'], ['interest_basis', 'text'], ['issuance_target', 'text'], ['market', 'text'], ['receiving_account', 'text'], ['trustee', 'text'], ['bookrunner', 'text']],
		income_certificate: [['liquidation_submission_status', 'text'], ['liquidation_registration_status', 'text'], ['return_type', 'text'], ['subscription_date', 'date'], ['redemption_date', 'date'], ['receiving_account', 'text'], ['early_maturity', 'boolean']],
		income_right: [['interest_basis_days', 'integer']],
		refinancing: [['interest_basis_days', 'integer'], ['market', 'text'], ['is_extended', 'boolean'], ['receiving_account', 'text'], ['repayment_account', 'text']],
		swap_facility: [['average_repo_balance_description', 'text'], ['repo_weighted_average_rate', 'numeric']]
	};
	for (const [table, extraColumns] of Object.entries(extensions)) {
		const tableRows = debtRows.filter((row) => row.table === table).map(({ table: _table, extension, ...row }) => ({ ...row, ...extension }));
		await bulkUpsert(table, [...common, ...extraColumns], tableRows, ['id'], []);
	}

	const cashflowsByDebt = new Map();
	for (const source of rows('debt_cashflow_events')) {
		const debtId = idByOldId.get(source.debt_id);
		const list = cashflowsByDebt.get(debtId) ?? [];
		list.push(source);
		cashflowsByDebt.set(debtId, list);
	}
	const cashflows = [];
	for (const [debtId, list] of cashflowsByDebt) {
		list.sort((left, right) => String(left.event_date).localeCompare(String(right.event_date))
			|| String(left.event_type).localeCompare(String(right.event_type))
			|| String(left.event_key).localeCompare(String(right.event_key)));
		list.forEach((source, index) => cashflows.push({
			debt_id: debtId, sequence: index + 1, cashflow_type: source.event_type,
			due_date: source.event_date, amount: source.amount == null ? null : Math.abs(Number(source.amount)),
			created_at: source.created_at, updated_at: source.updated_at
		}));
	}
	await bulkUpsert('cashflow', [
		['debt_id', 'bigint'], ['sequence', 'integer'], ['cashflow_type', 'text'], ['due_date', 'date'],
		['amount', 'numeric'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], cashflows, ['debt_id', 'sequence'], []);
	const balances = rows('debt_balance_daily').map((row) => ({
		as_of_date: row.as_of_date,
		debt_type: BOND_TYPES.has(row.debt_type) ? '债券' : row.debt_type,
		subtype: BOND_TYPES.has(row.debt_type) ? row.debt_type : '',
		amount: Number(row.balance_yi) * 100_000_000,
		created_at: row.created_at,
		updated_at: row.updated_at
	}));
	await bulkUpsert('balance_snapshot', [
		['as_of_date', 'date'], ['debt_type', 'text'], ['subtype', 'text'], ['amount', 'numeric'],
		['created_at', 'timestamptz'], ['updated_at', 'timestamptz']
	], balances, ['as_of_date', 'debt_type', 'subtype']);
	await client.query("SELECT setval('financing.debt_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM financing.debt), 1), true)");
	return { debts: debtRows.length, cashflows: cashflows.length, balances: balances.length };
}

if (dryRun) {
	const sourceDebts = rows('debts');
	const idByOldId = new Map(sourceDebts.map((debt, index) => [debt.id, index + 1]));
	const debtRows = makeDebtRows(idByOldId);
	const invalid = debtRows.filter((debt) => !debt.name || debt.amount < 0 || debt.interest_payable < 0);
	if (invalid.length) throw new Error(`负债转换校验失败：${JSON.stringify(invalid.slice(0, 5))}`);
	console.log(JSON.stringify({
		mode: 'dry-run', source: sourcePath, debts: debtRows.length,
		cashflows: rows('debt_cashflow_events').length, balances: rows('debt_balance_daily').length,
		workflow: {
			people: rows('people').length, skippedLegacyAuthAccounts: rows('auth_users').length,
			projects: rows('projects').length, projectTasks: rows('project_tasks').length,
			skippedLegacyReminderRules: rows('reminder_rules').length,
			skippedLegacyReminderDeliveries: rows('reminder_deliveries').length,
			auditLogs: rows('audit_logs').length
		},
		debtTables: debtRows.reduce((counts, debt) => {
			counts[debt.table] = (counts[debt.table] ?? 0) + 1;
			return counts;
		}, {})
	}, null, 2));
	sqlite.close();
	process.exit(0);
}

await client.connect();
try {
	const schema = await client.query("SELECT to_regclass('financing.debt') AS debt");
	if (!schema.rows[0].debt) throw new Error('目标库尚未初始化；请先执行 pnpm db:init -- --schema-only');
	await client.query('BEGIN');
	try {
		await client.query("SELECT pg_advisory_xact_lock(hashtext('financing.sqlite_migration'))");
		const workflow = await migrateWorkflowTables();
		const debt = await migrateDebts();
		await client.query('COMMIT');
		console.log(JSON.stringify({ source: sourcePath, workflow, ...debt, status: 'migrated' }, null, 2));
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	}
} finally {
	sqlite.close();
	await client.end();
}
