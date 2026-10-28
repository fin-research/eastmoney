import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { isValidEmail, normalizeEmail } from '../../src/lib/financing/email.js';
import { DATA_ADMIN_DEBT_TYPES, DEBT_TYPES } from '../../src/lib/financing/debt-types.js';
import { cacheSessionUser, invalidateCachedSession, readCachedSessionUser } from './fixtures/legacy-auth/auth-cache.js';
import { createNeonAuthClient, jwtFromResponseHeaders, NEON_SESSION_COOKIE, sessionMaxAgeFromSetCookie, sessionTokenFromSetCookie } from './fixtures/legacy-auth/neon-auth-client.js';
import { dataApiUrlFromAuthUrl } from '../../src/lib/financing/neon-urls.js';
import { deleteProjectWithReminders } from '../../src/lib/server/financing/project-deletion.js';
import { validateWorkbook } from '../../src/lib/financing/debt-import-json.ts';
import { importDebtWorkbook, refreshDebtImportDerivatives } from '../../src/lib/server/financing/debt-importer.js';
import { actionNameFromUrl, isAuthorizedRequest, isSafeRequestMethod } from './fixtures/legacy-auth/request-authorization.js';
import { PERMISSION_CODES } from './fixtures/legacy-auth/permissions.js';

function migrationSql(name) {
	return fs.readFileSync(new URL(`../../financing-migrations/${name}`, import.meta.url), 'utf8')
		.replace(/^\s*BEGIN\s*;?/i, '').replace(/\s*COMMIT\s*;?\s*$/i, '');
}

async function installSchema(db, { beforeReminderMigration } = {}) {
	await db.exec(`
		CREATE ROLE authenticated;
		CREATE ROLE anonymous;
		CREATE TABLE public.edb (
			indicator_code text NOT NULL,
			observation_date date NOT NULL,
			value numeric,
			PRIMARY KEY (indicator_code, observation_date)
		);
		CREATE SCHEMA auth;
		CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE AS $$
			SELECT current_setting('request.jwt.claim.sub', true)
		$$;
		CREATE SCHEMA neon_auth;
		CREATE TABLE neon_auth."user" (
			id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
			"emailVerified" boolean NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, role text, banned boolean
		);
		CREATE TABLE neon_auth.session (
			id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES neon_auth."user"(id),
			"createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);
	for (const name of [
		'0001_financing_postgres.sql',
		'0002_neon_auth_prepare.sql',
		'0003_remove_custom_auth.sql',
		'0004_data_api_rls.sql',
		'0005_hide_derived_data_api_tables.sql',
		'0006_enforce_single_debt_project.sql',
		'0007_detach_projects_from_debt.sql',
		'0008_sop_node_reminder_periods.sql',
		'0009_liability_report_sources_and_snapshots.sql',
		'0010_liability_report_daily_overwrite.sql',
		'0015_income_certificate_dates_and_names.sql',
		'0016_income_certificate_name_edge_cases.sql',
		'0017_normalize_refinancing_name.sql',
		'0018_liability_report_data_api.sql',
		'0019_allow_authenticated_liability_report_rpc.sql',
		'0020_optimize_liability_report_query.sql',
		'0021_online_debt_import_workflow.sql',
		'0022_remove_debt_import_state.sql',
		'0023_role_permissions.sql',
		'0028_client_master.sql'
	]) {
		if (name === '0008_sop_node_reminder_periods.sql' && beforeReminderMigration) {
			await beforeReminderMigration(db);
		}
		await db.exec(migrationSql(name));
	}
}

test('login emails are normalized and validated', () => {
	assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
	assert.equal(isValidEmail('user@example.com'), true);
	assert.equal(isValidEmail('legacy-admin'), false);
});

test('write authorization follows the persisted permission types', () => {
	assert.equal(actionNameFromUrl(new URL('https://example.com/financing/logout')), 'default');
	assert.equal(actionNameFromUrl(new URL('https://example.com/financing/projects?/createProject')), 'createProject');
	for (const method of ['GET', 'HEAD', 'OPTIONS']) {
		assert.equal(isSafeRequestMethod(method), true);
		assert.equal(isAuthorizedRequest([], '/projects', method), true);
	}
	assert.equal(isSafeRequestMethod('POST'), false);
	assert.equal(isAuthorizedRequest([], '/logout', 'POST'), true);
	assert.equal(isAuthorizedRequest([], '/settings', 'POST', 'updateProfile'), true);
	assert.equal(isAuthorizedRequest(PERMISSION_CODES, '/projects/[id]', 'POST', 'updateTask'), true);
	assert.equal(isAuthorizedRequest(['own_task_update'], '/projects/[id]', 'POST', 'updateOwnTaskStatus'), true);
	assert.equal(isAuthorizedRequest([], '/projects/[id]', 'POST', 'updateOwnTaskStatus'), false);
	assert.equal(isAuthorizedRequest(['people_manage'], '/people', 'POST', 'updatePerson'), true);
	assert.equal(isAuthorizedRequest([], '/people', 'POST', 'updatePerson'), false);
	assert.equal(isAuthorizedRequest(['permission_manage'], '/people', 'POST', 'saveRolePermissions'), true);
	assert.equal(isAuthorizedRequest(['data_manage'], '/data/import', 'POST'), true);
	for (const [permission, routeId, actions] of [
		['people_manage', '/people', ['createPerson', 'updatePerson', 'togglePerson', 'deletePerson']],
		['project_manage', '/projects', ['createProject', 'updateProject', 'deleteProject']],
		['project_manage', '/projects/[id]', ['updateProject', 'updateTask', 'addTask']],
		['sop_manage', '/sop', ['createReminder', 'createSop']],
		['sop_manage', '/sop/[id]', ['updateTemplate', 'toggleTemplate', 'addNode', 'updateNode', 'reorderNodes', 'deleteNode']],
		['report_generate', '/liability-report', ['saveSnapshot']]
	]) {
		for (const actionName of actions) {
			assert.equal(isAuthorizedRequest([permission], routeId, 'POST', actionName), true, `${routeId}:${actionName}`);
			assert.equal(isAuthorizedRequest([], routeId, 'POST', actionName), false, `${routeId}:${actionName}`);
		}
	}
	assert.equal(isAuthorizedRequest(PERMISSION_CODES, '/projects', 'POST', 'unknownAction'), false);
});

test('own-task action retains its narrow server-side field boundary', () => {
	const taskSource = fs.readFileSync(new URL('../../src/routes/financing/projects/[id]/+page.server.ts', import.meta.url), 'utf8');
	assert.match(taskSource, /updateOwnTaskStatus:/);
	assert.match(taskSource, /before\.assigneeId !== personId/);
	assert.match(taskSource, /WHERE id = \? AND project_id = \? AND assignee_id = \?/);
	const ownTaskAction = taskSource.slice(taskSource.indexOf('updateOwnTaskStatus:'), taskSource.indexOf('\n\taddTask:'));
	assert.match(ownTaskAction, /SET status = \?,\s*completed_at = CASE/);
	assert.doesNotMatch(ownTaskAction, /SET status = \?,\s*assignee_id = \?/);
});

test('Neon Auth session cookie is proxied without exposing the upstream cookie', async () => {
	const cookie = `${NEON_SESSION_COOKIE}=opaque-token; Max-Age=3600; Path=/; HttpOnly; Secure`;
	assert.equal(sessionTokenFromSetCookie(cookie), 'opaque-token');
	assert.equal(sessionMaxAgeFromSetCookie(cookie), 3600);
	const requests = [];
	const client = createNeonAuthClient({
		baseUrl: 'https://example.neonauth.us-west-2.aws.neon.tech/neondb/auth',
		origin: 'https://eastmoney.hasbai.xyz', token: 'opaque-token',
		fetchImpl: async (url, options) => {
			requests.push({ url: String(url), options });
			return new Response(JSON.stringify({ user: { id: 'auth-id', email: 'admin@example.com' } }), { status: 200, headers: { 'content-type': 'application/json', 'set-auth-jwt': 'short-lived-jwt' } });
		}
	});
	const session = await client.getSession();
	assert.equal(session.data.user.id, 'auth-id');
	assert.equal(session.jwt, 'short-lived-jwt');
	assert.equal(requests[0].options.headers.get('Cookie'), `${NEON_SESSION_COOKIE}=opaque-token`);
	assert.equal(requests[0].options.headers.get('Origin'), 'https://eastmoney.hasbai.xyz');
});

test('Data API JWT is read from the dedicated Neon Auth response header', () => {
	assert.equal(jwtFromResponseHeaders(new Headers({ 'Set-Auth-Jwt': ' jwt-value ' })), 'jwt-value');
	assert.equal(jwtFromResponseHeaders(new Headers()), null);
});

test('Data API token requests bypass the Neon Auth session cookie cache', async () => {
	const requests = [];
	const client = createNeonAuthClient({
		baseUrl: 'https://example.neonauth.us-west-2.aws.neon.tech/neondb/auth',
		origin: 'https://eastmoney.hasbai.xyz', token: 'opaque-token',
		fetchImpl: async (url) => {
			requests.push(String(url));
			return new Response(JSON.stringify({ user: { id: 'auth-id' } }), {
				status: 200,
				headers: { 'content-type': 'application/json', 'set-auth-jwt': 'short-lived-jwt' }
			});
		}
	});
	const session = await client.getSession({ disableCookieCache: true });
	assert.equal(session.jwt, 'short-lived-jwt');
	assert.equal(new URL(requests[0]).searchParams.get('disableCookieCache'), 'true');
	const hooksSource = fs.readFileSync(new URL('../../src/lib/server/gateway-context.ts', import.meta.url), 'utf8');
	assert.match(hooksSource, /env\.GATEWAY_CONTEXT/);
	assert.doesNotMatch(hooksSource, /readCachedSessionUser/);
});

test('short-lived Worker auth cache hashes opaque tokens and can be invalidated', async () => {
	const entries = new Map();
	const writes = [];
	const cache = {
		async match(request) { return entries.get(request.url)?.clone(); },
		async put(request, response) { entries.set(request.url, response.clone()); },
		async delete(request) { return entries.delete(request.url); }
	};
	const event = {
		url: new URL('https://eastmoney.hasbai.xyz/financing/projects'),
		platform: {
			caches: { async open() { return cache; } },
			context: { waitUntil(promise) { writes.push(promise); } }
		}
	};
	const user = {
		id: 'auth-id', email: 'admin@example.com', role: 'admin', personId: 'person-id',
		personName: '管理员', hasAvatar: false, avatarVersion: '1'
	};
	await cacheSessionUser(event, 'opaque-session-token', user);
	await Promise.all(writes);
	assert.equal(entries.size, 1);
	assert.equal([...entries.keys()][0].includes('opaque-session-token'), false);
	assert.deepEqual(await readCachedSessionUser(event, 'opaque-session-token'), user);
	assert.equal(await invalidateCachedSession(event, 'opaque-session-token'), true);
	assert.equal(await readCachedSessionUser(event, 'opaque-session-token'), null);
});

test('收益凭证在数据后台合并、在仪表盘筛选中保留浮动和固定分类', () => {
	assert.deepEqual(
		DEBT_TYPES.filter((item) => item.type === '收益凭证').map((item) => item.label),
		['浮动收益凭证', '固定收益凭证']
	);
	const adminEntities = DATA_ADMIN_DEBT_TYPES.filter((item) => item.type === '收益凭证');
	assert.equal(adminEntities.length, 1);
	assert.equal(adminEntities[0].label, '收益凭证');
	assert.equal(adminEntities[0].filterSubtype, false);
	assert.deepEqual(adminEntities[0].subtypeOptions.map((item) => item.value), ['浮动收益凭证', '固定收益凭证']);
	const adminSource = fs.readFileSync(new URL('../../src/lib/financing/data-admin.ts', import.meta.url), 'utf8');
	assert.match(adminSource, /DATA_ADMIN_DEBT_TYPES\.map/);
	assert.match(adminSource, /item\.filterSubtype \? \{ subtype: item\.fixedSubtype \} : \{\}/);
});

test('Data API URL is derived from the branch-scoped Neon Auth URL', () => {
	assert.equal(
		dataApiUrlFromAuthUrl('https://ep-example.neonauth.us-west-2.aws.neon.tech/neondb/auth'),
		'https://ep-example.apirest.us-west-2.aws.neon.tech/neondb/rest/v1'
	);
	assert.equal(dataApiUrlFromAuthUrl('https://example.com/auth'), null);
});

test('SOP-node reminder migration removes legacy rules before installing the new relation model', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db, {
		beforeReminderMigration: async (database) => {
			await database.exec(`
				INSERT INTO financing.reminder_rules (id, name, trigger_field)
				VALUES ('legacy-rule', '旧提醒', 'due_date');
				INSERT INTO financing.reminder_deliveries (
					id, rule_id, target_type, target_id, delivery_date, recipients, status
				) VALUES ('legacy-delivery', 'legacy-rule', 'project_task', 'task', '2026-08-23', '[]', 'sent');
			`);
		}
	});
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.reminder_rules')).rows[0].count, 0);
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.reminder_deliveries')).rows[0].count, 0);
	const ruleColumns = (await db.query(`
		SELECT column_name FROM information_schema.columns
		WHERE table_schema = 'financing' AND table_name = 'reminder_rules'
	`)).rows.map((row) => row.column_name);
	assert.equal(ruleColumns.includes('frequency'), false);
	assert.equal(ruleColumns.includes('offset_days'), false);
	assert.equal((await db.query("SELECT to_regclass('financing.reminder_rule_nodes') AS table_name")).rows[0].table_name, 'financing.reminder_rule_nodes');
	assert.equal((await db.query("SELECT to_regclass('financing.reminder_rule_periods') AS table_name")).rows[0].table_name, 'financing.reminder_rule_periods');
});

test('closed-month financing metrics are filled once and remain frozen on later report calls', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db);
	await db.exec(`
		DELETE FROM financing.monthly_financing_metrics
		WHERE month_end = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - 1;
		INSERT INTO financing.balance_snapshot (as_of_date, debt_type, subtype, amount)
		VALUES (
			date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - 1,
			'测试负债', '', 100000000
		);
		INSERT INTO financing.debt (
			id, debt_type, name, amount, annual_rate, issue_date, maturity_date, activated_at
		) VALUES (
			900001, '测试负债', '月度缓存测试', 100000000, 0.02,
			date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - INTERVAL '1 month',
			date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date + INTERVAL '1 year',
			date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - INTERVAL '1 month'
		);
	`);
	const firstRefresh = (await db.query(`
		SELECT financing.refresh_monthly_financing_metrics(
			(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
		) AS inserted
	`)).rows[0];
	assert.equal(firstRefresh.inserted, 1);
	const first = (await db.query(`
		SELECT balance_yi, weighted_rate_pct, weighted_days
		FROM financing.monthly_financing_metrics
		WHERE month_end = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - 1
	`)).rows[0];
	assert.equal(Number(first.balance_yi), 1);
	assert.equal(Number(first.weighted_rate_pct), 2);
	assert.ok(Number(first.weighted_days) > 0);

	await db.exec(`
		UPDATE financing.debt SET annual_rate = 0.03 WHERE id = 900001;
		UPDATE financing.balance_snapshot SET amount = 200000000 WHERE debt_type = '测试负债';
	`);
	const secondRefresh = (await db.query(`
		SELECT financing.refresh_monthly_financing_metrics(
			(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
		) AS inserted
	`)).rows[0];
	assert.equal(secondRefresh.inserted, 0);
	const frozen = (await db.query(`
		SELECT balance_yi, weighted_rate_pct
		FROM financing.monthly_financing_metrics
		WHERE month_end = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - 1
	`)).rows[0];
	assert.equal(Number(frozen.balance_yi), 1);
	assert.equal(Number(frozen.weighted_rate_pct), 2);

	const importRefresh = await refreshDebtImportDerivatives(
		db,
		new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
	);
	assert.ok(importRefresh.refreshedCount > 0);
	const refreshed = (await db.query(`
		SELECT balance_yi, weighted_rate_pct
		FROM financing.monthly_financing_metrics
		WHERE month_end = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::date - 1
	`)).rows[0];
	assert.equal(Number(refreshed.balance_yi), 2);
	assert.equal(Number(refreshed.weighted_rate_pct), 3);
});

test('online debt imports do not persist payload or status tables in Neon', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db);
	const relations = (await db.query(`
		SELECT to_regclass('financing.debt_import_runs') AS run_table,
			to_regclass('financing.debt_import_payloads') AS payload_table
	`)).rows[0];
	assert.equal(relations.run_table, null);
	assert.equal(relations.payload_table, null);
});

test('shared debt importer is idempotent and preserves mutable historical fields', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db);
	await db.exec("INSERT INTO public.client(name,type) VALUES ('集团公司','其它')");
	const transformed = {
		snapshot: { asOfDate: '2026-09-03', totalYi: 1 },
		debts: [{
			sourceKey: 'group-loan-1', table: 'debt', debtType: '集团借款', subtype: null,
			name: '集团借款·集团公司·2026-09-01', legacyName: '集团借款·集团公司·2026-09-01',
			counterparty: '集团公司', amount: 100000000, interestPayable: 0,
			annualRate: 0.02, issueDate: '2026-09-01', maturityDate: '2027-09-01',
			activatedAt: '2026-09-01', settledAt: null, closedAt: null, extension: {}
		}],
		cashflows: [],
		balances: [{ asOfDate: '2026-09-03', debtType: '集团借款', subtype: '', amount: 100000000 }]
	};
	const inserted = await importDebtWorkbook(db, transformed);
	assert.equal(inserted.insertedDebtCount, 1);
	assert.equal(inserted.updatedDebtCount, 0);
	transformed.debts[0].annualRate = 0.025;
	const updated = await importDebtWorkbook(db, transformed);
	assert.equal(updated.insertedDebtCount, 0);
	assert.equal(updated.updatedDebtCount, 0);
	assert.equal(updated.skippedDebtCount, 1);
	const decoded = validateWorkbook(JSON.parse(JSON.stringify(transformed)));
	const jsonUpdated = await importDebtWorkbook(db, decoded);
	assert.equal(jsonUpdated.insertedDebtCount, 0);
	assert.equal(jsonUpdated.updatedDebtCount, 0);
	const rows = (await db.query("SELECT amount, annual_rate FROM financing.debt WHERE name = '集团借款·集团公司·2026-09-01'")).rows;
	assert.equal(rows.length, 1);
	assert.equal(Number(rows[0].amount), 100000000);
	assert.equal(Number(rows[0].annual_rate), 0.02);
});

test('Data API RLS lets every active financing role edit and writes audit records', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db);
	const roles = ['admin', 'handler', 'reviewer'];
	const debtFixtures = [
		{ table: 'bond', debtType: '债券', subtype: '小公募' },
		{ table: 'income_certificate', debtType: '收益凭证', subtype: '固定收益凭证' },
		{ table: 'swap_facility', debtType: '互换便利', subtype: null }
	];
	for (const [index, role] of roles.entries()) {
		const authId = `00000000-0000-4000-8000-00000000000${index + 1}`;
		await db.query('INSERT INTO neon_auth."user" (id, name, email, "emailVerified", role) VALUES ($1, $2, $3, TRUE, $4)', [authId, role, `${role}@example.com`, role]);
		await db.query('INSERT INTO financing.people (id, name, email, role, neon_auth_user_id) VALUES ($1, $2, $3, $4, $5)', [`person-${role}`, role, `${role}@example.com`, role, authId]);
		await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authId]);
		await db.exec('SET ROLE authenticated');
		await db.query('INSERT INTO financing.finance_parameters (code, label, value_yi) VALUES ($1, $2, $3)', [`rls-${role}`, role, index + 1]);
		await db.query('UPDATE financing.finance_parameters SET value_yi = $1 WHERE code = $2', [index + 10, `rls-${role}`]);
		const fixture = debtFixtures[index];
		const debt = (await db.query(
			`INSERT INTO financing.${fixture.table} (debt_type, subtype, name, amount, issue_date) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[fixture.debtType, fixture.subtype, `rls-${role}`, index + 100, `2026-08-0${index + 1}`]
		)).rows[0];
		await db.query(`UPDATE financing.${fixture.table} SET amount = $1 WHERE id = $2`, [index + 200, debt.id]);
		await db.exec('RESET ROLE');
	}
	const saved = (await db.query("SELECT code, value_yi FROM financing.finance_parameters WHERE code LIKE 'rls-%' ORDER BY code")).rows;
	assert.equal(saved.length, 3);
	const audit = (await db.query("SELECT COUNT(*)::integer AS count FROM financing.audit_logs WHERE entity_type = 'finance_parameter' AND entity_id LIKE 'rls-%'")).rows[0];
	assert.equal(audit.count, 6);
	const debtAudit = (await db.query("SELECT COUNT(*)::integer AS count FROM financing.audit_logs WHERE entity_type = 'debt' AND summary LIKE 'Data API %'")).rows[0];
	assert.equal(debtAudit.count, 6);
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.role_permissions WHERE granted = TRUE')).rows[0].count, 21);

	await db.query("UPDATE financing.role_permissions SET granted = FALSE WHERE role = 'handler' AND permission_code = 'data_manage'");
	await db.query("SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false)");
	await db.exec('SET ROLE authenticated');
	await assert.rejects(db.query("INSERT INTO financing.finance_parameters (code, label) VALUES ('rls-handler-denied', 'denied')"), /row-level security|policy/i);
	await db.exec('RESET ROLE');

	const inactiveAuthId = '00000000-0000-4000-8000-000000000009';
	await db.query('INSERT INTO neon_auth."user" (id, name, email, "emailVerified", role) VALUES ($1, $2, $3, TRUE, $4)', [inactiveAuthId, 'inactive', 'inactive@example.com', 'reviewer']);
	await db.query("INSERT INTO financing.people (id, name, email, role, active, neon_auth_user_id) VALUES ('inactive', 'inactive', 'inactive@example.com', 'reviewer', FALSE, $1)", [inactiveAuthId]);
	await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [inactiveAuthId]);
	await db.exec('SET ROLE authenticated');
	await assert.rejects(db.query("INSERT INTO financing.finance_parameters (code, label) VALUES ('rls-denied', 'denied')"), /row-level security|policy/i);
	await db.exec('RESET ROLE');

	for (const table of ['cashflow', 'balance_snapshot', 'audit_logs']) {
		const privilege = (await db.query(
			"SELECT has_table_privilege('authenticated', $1, 'SELECT') AS can_select, has_table_privilege('authenticated', $1, 'INSERT') AS can_insert",
			[`financing.${table}`]
		)).rows[0];
		assert.equal(privilege.can_select, false);
		assert.equal(privilege.can_insert, false);
	}
});

test('PostgreSQL schema removes custom auth and preserves debt integrity', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db);
	const authTables = (await db.query("SELECT to_regclass('financing.auth_users') AS users, to_regclass('financing.auth_sessions') AS sessions")).rows[0];
	assert.equal(authTables.users, null);
	assert.equal(authTables.sessions, null);
	const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'financing' AND table_name = 'people'")).rows.map((row) => row.column_name);
	assert.ok(columns.includes('neon_auth_user_id'));
	assert.ok(columns.includes('avatar_data_url'));
	assert.equal((await db.query("SELECT to_regclass('financing.role_permissions') AS table_name")).rows[0].table_name, 'financing.role_permissions');
	const debtColumns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'financing' AND table_name = 'debt'")).rows.map((row) => row.column_name);
	assert.equal(debtColumns.includes('project_id'), false);
	for (const table of ['liability_market_observations', 'liability_peer_issuances', 'liability_registration_progress']) {
		assert.equal((await db.query('SELECT to_regclass($1) AS table_name', [`financing.${table}`])).rows[0].table_name, null);
	}
	assert.equal(
		(await db.query("SELECT to_regprocedure('financing.liability_weekly_report_data(date)')::text AS function_name")).rows[0].function_name,
		'financing.liability_weekly_report_data(date)'
	);
	assert.equal(
		(await db.query("SELECT has_function_privilege('authenticated', 'financing.liability_weekly_report_data(date)', 'EXECUTE') AS allowed")).rows[0].allowed,
		true
	);
	assert.equal(
		(await db.query("SELECT has_function_privilege('anonymous', 'financing.liability_weekly_report_data(date)', 'EXECUTE') AS allowed")).rows[0].allowed,
		false
	);
	assert.equal((await db.query("SELECT to_regclass('financing.monthly_financing_metrics') AS table_name")).rows[0].table_name, 'financing.monthly_financing_metrics');
	assert.equal((await db.query("SELECT to_regclass('financing.liability_market_rate_observations') AS view_name")).rows[0].view_name, 'financing.liability_market_rate_observations');
	assert.equal(
		(await db.query("SELECT has_table_privilege('authenticated', 'financing.monthly_financing_metrics', 'SELECT') AS allowed")).rows[0].allowed,
		false
	);
	assert.equal(
		(await db.query("SELECT has_table_privilege('authenticated', 'financing.liability_market_rate_observations', 'SELECT') AS allowed")).rows[0].allowed,
		true
	);
	await db.exec(`
		INSERT INTO public.edb (indicator_code, observation_date, value) VALUES
			('E1707781', '2026-09-02', 2.1),
			('UNRELATED', '2026-09-02', 9.9)
	`);
	await db.exec('SET ROLE authenticated');
	const marketRows = (await db.query('SELECT indicator_code, value FROM financing.liability_market_rate_observations')).rows;
	assert.deepEqual(marketRows.map((row) => row.indicator_code), ['E1707781']);
	await assert.rejects(db.query('SELECT * FROM public.edb'), /permission denied/i);
	const reportPayload = (await db.query(`
		SELECT financing.liability_weekly_report_data(
			(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
		) AS payload
	`)).rows[0].payload;
	await db.exec('RESET ROLE');
	assert.equal(reportPayload.version, 1);
	assert.equal(reportPayload.report.asOfDate, new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));

	await db.query("INSERT INTO financing.people (id, name, email, role) VALUES ('one', '甲', 'user@example.com', 'handler')");
	await assert.rejects(db.query("INSERT INTO financing.people (id, name, email, role) VALUES ('two', '乙', 'USER@example.com', 'reviewer')"), /duplicate key value|unique constraint/i);
	await db.exec(`
		INSERT INTO financing.sop_templates (id, name, debt_type) VALUES ('sop', '测试 SOP', '小公募');
		INSERT INTO financing.sop_nodes (id, template_id, name, sort_order) VALUES ('node', 'sop', '测试节点', 1);
		INSERT INTO financing.projects (id, code, name, debt_type, sop_template_id) VALUES ('project', 'P-1', '测试项目', '小公募', 'sop');
	`);
	await db.query(`INSERT INTO financing.bond (id, debt_type, subtype, name, amount, interest_payable, annual_rate, issue_date, maturity_date, activated_at)
		VALUES (101, '债券', '小公募', '26东财01', 1000, 25, 0.02, '2026-01-01', '2027-01-01', '2026-01-01')`);
	await db.query("INSERT INTO financing.debt (id, debt_type, name, amount) VALUES (102, '集团借款', '独立负债', 100)");
	const debt = (await db.query('SELECT total_amount, term_days, status, tableoid::regclass::text AS physical_table FROM financing.debt WHERE id = 101')).rows[0];
	assert.equal(Number(debt.total_amount), 1025);
	assert.equal(debt.term_days, 365);
	assert.equal(debt.status, 'active');
	assert.equal(debt.physical_table, 'financing.bond');
	await assert.rejects(db.query("INSERT INTO financing.income_certificate (id, debt_type, subtype, name, amount) VALUES (101, '收益凭证', '固定收益凭证', '冲突凭证', 100)"), /duplicate debt id/i);
	await db.query(`INSERT INTO financing.income_certificate (
		id, debt_type, subtype, name, amount, subscription_date, redemption_date, activated_at
	) VALUES (103, '收益凭证', '固定收益凭证', '东方财富证券财气东来两年期1918号收益凭证', 150000,
		'2026-09-01', '2026-09-07', '2026-09-01')`);
	const certificate = (await db.query('SELECT name, maturity_date, subscription_date, redemption_date FROM financing.income_certificate WHERE id = 103')).rows[0];
	assert.equal(certificate.name, '财气东来1918号收益凭证');
	assert.equal(new Date(certificate.maturity_date).toISOString().slice(0, 10), '2026-09-04');
	assert.equal(new Date(certificate.subscription_date).toISOString().slice(0, 10), '2026-09-01');
	assert.equal(new Date(certificate.redemption_date).toISOString().slice(0, 10), '2026-09-07');
	await db.query(`INSERT INTO financing.refinancing (
		id, debt_type, name, counterparty, amount, issue_date, maturity_date, activated_at
	) VALUES (104, '转融资', '转融资·不应保留的对手方·2026-01-01', '测试对手方', 200000,
		'2026-01-01', '2026-12-31', '2026-01-01')`);
	const refinancing = (await db.query('SELECT name, counterparty FROM financing.refinancing WHERE id = 104')).rows[0];
	assert.equal(refinancing.name, '转融资');
	assert.equal(refinancing.counterparty, '测试对手方');
	await db.query("INSERT INTO financing.cashflow (debt_id, cashflow_type, due_date, amount) VALUES (101, 'interest', '2026-12-31', 25)");
	assert.equal((await db.query('SELECT sequence FROM financing.cashflow')).rows[0].sequence, 1);
	await assert.rejects(db.query("INSERT INTO financing.cashflow (debt_id, cashflow_type, due_date, amount) VALUES (999, 'principal', '2026-12-31', 100)"), /debt does not exist/i);
	await db.exec(`
		INSERT INTO financing.project_tasks (id, project_id, sop_node_id, name, due_date) VALUES ('task', 'project', 'node', '测试节点', '2026-08-23');
		INSERT INTO financing.reminder_rules (id, name) VALUES ('rule', '测试提醒');
		INSERT INTO financing.reminder_rule_nodes (rule_id, sop_node_id) VALUES ('rule', 'node');
		INSERT INTO financing.reminder_rule_periods (id, rule_id, lead_hours, sort_order) VALUES ('period', 'rule', 36, 1);
		INSERT INTO financing.reminder_deliveries (id, rule_id, period_id, target_type, target_id, delivery_date, scheduled_for, recipients, status) VALUES
			('delivery-project', 'rule', 'period', 'project', 'project', '2026-08-23', '2026-08-22T04:00:00Z', '[]', 'pending'),
			('delivery-task', 'rule', 'period', 'project_task', 'task', '2026-08-23', '2026-08-22T04:00:00Z', '[]', 'pending'),
			('delivery-debt', 'rule', 'period', 'debt', '101', '2026-08-23', '2026-08-22T04:00:00Z', '[]', 'pending');
	`);
	const deleted = await deleteProjectWithReminders(db, 'project');
	assert.equal(deleted.taskCount, 1);
	assert.equal(deleted.reminderCount, 2);
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.projects')).rows[0].count, 0);
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.project_tasks')).rows[0].count, 0);
	assert.deepEqual(
		(await db.query('SELECT id FROM financing.reminder_deliveries ORDER BY id')).rows.map((row) => row.id),
		['delivery-debt']
	);
	assert.equal(await deleteProjectWithReminders(db, 'project'), null);
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.debt')).rows[0].count, 4);
	await db.query('DELETE FROM financing.bond WHERE id = 101');
	assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM financing.cashflow')).rows[0].count, 0);
});

test('monthly financial wide table migrates history, computes ratios and enforces dated RLS writes', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await installSchema(db);
	await db.exec(`
		INSERT INTO financing.finance_parameters (code, label, value_yi, period_end) VALUES
			('total_assets', '总资产', 100, '2026-07-31'),
			('total_liabilities', '总负债', 70, '2026-07-31'),
			('agency_brokerage_funds', '代理买卖证券款', 20, '2026-07-31'),
			('asset_liability_ratio', '资产负债率', 0.7, '2026-07-31'),
			('securities_prior_year_net_assets', '证券上年末净资产', 25, '2025-12-31'),
			('prior_month_net_capital', '上月末净资本', 30, '2026-07-31');
	`);
	await db.exec(migrationSql('0024_financial_metric_history.sql'));
	const July = (await db.query("SELECT * FROM financing.financial_monthly_data WHERE period_end = '2026-07-31'")).rows[0];
	assert.equal(Number(July.asset_liability_ratio), 0.7);
	assert.equal(Number(July.adjusted_asset_liability_ratio), 0.625);
	assert.equal((await db.query('SELECT count(*)::integer AS count FROM financing.financial_monthly_data')).rows[0].count, 2);
	await assert.rejects(db.query("INSERT INTO financing.financial_monthly_data (period_end, total_assets) VALUES ('2026-07-31', 200)"), /duplicate key|unique constraint/);
	await assert.rejects(db.query("INSERT INTO financing.financial_monthly_data (period_end, total_assets) VALUES ('2026-08-01', 200)"), /check constraint/);
	await assert.rejects(db.query("UPDATE financing.financial_monthly_data SET asset_liability_ratio = 0.8 WHERE period_end = '2026-07-31'"), /DEFAULT/i);
	await db.exec("INSERT INTO financing.financial_monthly_data (period_end, net_capital, total_assets, total_liabilities, agency_brokerage_funds) VALUES ('2026-08-31', 40, 200, 160, 40)");
	const atAugust = (await db.query("SELECT * FROM financing.finance_parameters_as_of('2026-08-15')")).rows;
	assert.equal(Number(atAugust.find((row) => row.code === 'total_assets').value_yi), 100);
	assert.equal(Number(atAugust.find((row) => row.code === 'prior_month_net_capital').value_yi), 30);
	assert.equal(Number(atAugust.find((row) => row.code === 'securities_prior_year_net_assets').value_yi), 25);
	const atSeptember = (await db.query("SELECT * FROM financing.finance_parameters_as_of('2026-09-01')")).rows;
	assert.equal(Number(atSeptember.find((row) => row.code === 'total_assets').value_yi), 200);
	assert.equal(Number(atSeptember.find((row) => row.code === 'prior_month_net_capital').value_yi), 40);
	const report = (await db.query("SELECT financing.liability_weekly_report_data('2026-08-15') AS payload")).rows[0].payload;
	assert.equal(Number(report.report.parameters.total_assets.valueYi), 100);
	await db.exec("UPDATE financing.financial_monthly_data SET total_liabilities = 60 WHERE period_end = '2026-07-31'");
	assert.equal(Number((await db.query("SELECT asset_liability_ratio FROM financing.financial_monthly_data WHERE period_end = '2026-07-31'")).rows[0].asset_liability_ratio), 0.6);
	assert.equal(Number((await db.query("SELECT total_liabilities FROM financing.financial_monthly_data WHERE period_end = '2026-08-31'")).rows[0].total_liabilities), 160);
	await db.exec("INSERT INTO financing.financial_monthly_data (period_end, total_assets, total_liabilities, agency_brokerage_funds) VALUES ('2026-06-30', 0, 0, 0)");
	const zero = (await db.query("SELECT asset_liability_ratio, adjusted_asset_liability_ratio FROM financing.financial_monthly_data WHERE period_end = '2026-06-30'")).rows[0];
	assert.equal(zero.asset_liability_ratio, null);
	assert.equal(zero.adjusted_asset_liability_ratio, null);
	await db.exec('SET ROLE authenticated');
	await assert.rejects(db.query("INSERT INTO financing.financial_monthly_data (period_end, total_assets) VALUES ('2026-05-31', 1)"), /row-level security|policy/i);
	assert.equal((await db.query('SELECT * FROM financing.financial_monthly_data')).rows.length, 0);
	await db.exec('RESET ROLE');
	await db.exec(`
		INSERT INTO neon_auth."user" (id, name, email, "emailVerified", role) VALUES ('00000000-0000-4000-8000-000000000091', 'monthly', 'monthly@example.com', TRUE, 'admin');
		INSERT INTO financing.people (id, name, email, role, neon_auth_user_id) VALUES ('monthly', 'monthly', 'monthly@example.com', 'admin', '00000000-0000-4000-8000-000000000091');
		SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000091', false);
		SET ROLE authenticated;
	`);
	await db.exec("UPDATE financing.financial_monthly_data SET total_assets = 110 WHERE period_end = '2026-07-31'");
	await assert.rejects(db.query("UPDATE financing.finance_parameters SET value_yi = 200 WHERE code = 'total_assets'"), /permission denied/);
	await db.exec('RESET ROLE');
	const audit = (await db.query("SELECT entity_id FROM financing.audit_logs WHERE summary = 'Data API update financial_monthly_data'")).rows;
	assert.deepEqual(audit.map((row) => row.entity_id), ['2026-07-31']);
	await db.exec("UPDATE financing.role_permissions SET granted = FALSE WHERE role = 'admin' AND permission_code = 'data_manage'");
	await db.exec('SET ROLE authenticated');
	await assert.rejects(db.query("INSERT INTO financing.financial_monthly_data (period_end, total_assets) VALUES ('2026-05-31', 1)"), /row-level security|policy/i);
});

test('retired Neon identity keeps Auth0 RLS and audit working without old auth schemas', async () => {
	const db = new PGlite();
	try {
		await installSchema(db);
		const id = '00000000-0000-4000-8000-000000000099';
		await db.query('INSERT INTO neon_auth."user" (id, name, email, "emailVerified", role) VALUES ($1, $2, $3, FALSE, $4)', [id, 'migration', 'migration@18.cn', 'admin']);
		await db.query('INSERT INTO financing.people (id, name, email, role, neon_auth_user_id) VALUES ($1, $2, $3, $4, $5)', ['migration', 'migration', 'migration@18.cn', 'admin', id]);
		for (const name of ['0025_auth0_identity.sql', '0026_auth0_request_context.sql', '0027_retire_neon_identity.sql']) await db.exec(migrationSql(name));
		await db.exec('DROP SCHEMA neon_auth CASCADE; DROP SCHEMA auth CASCADE;');
		const person = (await db.query('SELECT auth0_user_id FROM financing.people WHERE id = $1', ['migration'])).rows[0];
		assert.equal(person.auth0_user_id, `auth0|${id}`);
		await db.exec("BEGIN; UPDATE financing.people SET auth0_permissions=ARRAY['data_manage'], auth0_authorized_until=CURRENT_TIMESTAMP + interval '60 seconds' WHERE id='migration';");
		await db.query("SELECT set_config('request.financing.user_id', $1, true)", [person.auth0_user_id]);
		await db.exec('SET LOCAL ROLE authenticated;');
		assert.equal((await db.query('SELECT financing.current_app_user_can_edit() AS allowed')).rows[0].allowed, true);
		await db.exec("INSERT INTO financing.finance_parameters (code, label, value_yi) VALUES ('migration-fixture', 'migration fixture', 1);");
		await db.exec('RESET ROLE;');
		assert.ok((await db.query("SELECT count(*)::int AS count FROM financing.audit_logs WHERE actor_person_id='migration'")).rows[0].count > 0);
		await db.exec("UPDATE financing.people SET auth0_authorized_until=CURRENT_TIMESTAMP - interval '1 second'; SET LOCAL ROLE authenticated;");
		assert.equal((await db.query('SELECT financing.current_app_user_can_edit() AS allowed')).rows[0].allowed, false);
		assert.equal((await db.query('SELECT count(*)::int AS count FROM financing.finance_parameters')).rows[0].count, 0);
		await db.exec('ROLLBACK;');
	} finally { await db.close(); }
});
