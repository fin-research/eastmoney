import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
	MAX_REMINDER_PERIODS,
	parseReminderPeriods,
	reminderPeriodLabel
} from '../../src/lib/financing/reminder-periods.js';
import { collectDueReminders } from '../../src/lib/server/financing/reminders.js';
import { runScheduledReminderCheck } from '../../src/lib/server/financing/reminder-scheduler.js';

function restoreAliases(rows, sql) {
	const aliases = new Map(
		[...sql.matchAll(/\bAS\s+([A-Za-z][A-Za-z0-9_]*)/gi)]
			.map((match) => [match[1].toLowerCase(), match[1]])
	);
	return rows.map((row) => Object.fromEntries(
		Object.entries(row).map(([key, value]) => [aliases.get(key) ?? key, value])
	));
}

function databaseAdapter(database) {
	return {
		prepare(sql) {
			return {
				async all(...values) {
					let index = 0;
					const compiled = sql.replace(/\?/g, () => `$${++index}`);
					const result = await database.query(compiled, values);
					return restoreAliases(result.rows, sql);
				}
			};
		}
	};
}

test('reminder periods accept multiple unique day-hour lead times', () => {
	assert.deepEqual(parseReminderPeriods(['3', '0', '1'], ['0', '6', '12']), {
		periods: [
			{ days: 3, hours: 0, leadHours: 72, sortOrder: 1 },
			{ days: 0, hours: 6, leadHours: 6, sortOrder: 2 },
			{ days: 1, hours: 12, leadHours: 36, sortOrder: 3 }
		]
	});
	assert.equal(parseReminderPeriods(['1', '0'], ['0', '24']).error, '第 2 个周期的小时应为 0–23 之间的整数');
	assert.equal(parseReminderPeriods(['1', '1'], ['0', '0']).error, '提醒周期不能重复');
	assert.match(parseReminderPeriods(Array(MAX_REMINDER_PERIODS + 1).fill('1'), Array(MAX_REMINDER_PERIODS + 1).fill('0')).error, /1–20/);
	assert.equal(reminderPeriodLabel(0), '节点到期日（09:00）');
	assert.equal(reminderPeriodLabel(48), '提前 2 天（09:00）');
	assert.equal(reminderPeriodLabel(36), '提前 1 天 12 小时');
});

test('reminder core is Worker-safe and requires an injected database', async () => {
	await assert.rejects(collectDueReminders(), /必须显式传入数据库连接/);
	const source = fs.readFileSync(new URL('../../src/lib/server/financing/reminders.js', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /import\(['"]\.\/db\.js['"]\)/);
});

test('due reminders match selected SOP nodes and independently expose each due period', async (t) => {
	const database = new PGlite();
	t.after(() => database.close());
	await database.exec(`
		CREATE SCHEMA financing;
		SET search_path TO financing, public;
		CREATE TABLE sop_templates (id text PRIMARY KEY, name text, debt_type text, is_active boolean);
		CREATE TABLE sop_nodes (id text PRIMARY KEY, template_id text, name text);
		CREATE TABLE projects (id text PRIMARY KEY, name text, debt_type text, sop_template_id text, owner_id text);
		CREATE TABLE project_tasks (
			id text PRIMARY KEY, project_id text, sop_node_id text, name text,
			status text, due_date date, assignee_id text
		);
		CREATE TABLE reminder_rules (
			id text PRIMARY KEY, name text, recipient_mode text, recipients jsonb, is_active boolean
		);
		CREATE TABLE reminder_rule_nodes (rule_id text, sop_node_id text);
		CREATE TABLE reminder_rule_periods (id text PRIMARY KEY, rule_id text, lead_hours integer);
		INSERT INTO sop_templates VALUES ('sop', '债券 SOP', '小公募', TRUE);
		INSERT INTO sop_nodes VALUES ('selected-node', 'sop', '申报'), ('other-node', 'sop', '发行');
		INSERT INTO projects VALUES ('project', '测试项目', '小公募', 'sop', 'owner');
		INSERT INTO project_tasks VALUES
			('selected-task', 'project', 'selected-node', '申报任务', 'not_started', '2026-08-25', 'assignee'),
			('other-task', 'project', 'other-node', '发行任务', 'not_started', '2026-08-25', 'assignee');
		INSERT INTO reminder_rules VALUES ('rule', '节点提醒', 'assignee', NULL, TRUE);
		INSERT INTO reminder_rule_nodes VALUES ('rule', 'selected-node');
		INSERT INTO reminder_rule_periods VALUES
			('period-48', 'rule', 48), ('period-36', 'rule', 36), ('period-6', 'rule', 6);
	`);

	await database.exec("ALTER TABLE project_tasks ADD COLUMN schedule_type text DEFAULT 'period', ADD COLUMN planned_start_date date DEFAULT '2026-08-01'");
	const db = databaseAdapter(database);
	const directory = async () => [{id:'assignee',email:'assignee@example.com',active:true},{id:'owner',email:'owner@example.com',active:true}];
	assert.deepEqual(await collectDueReminders({ asOf: '2026-08-01T01:00:00.000Z', db, directory }), []);
	const beforeDailySend = await collectDueReminders({ asOf: '2026-08-23T00:59:59.000Z', db, directory });
	assert.deepEqual(beforeDailySend, []);

	const dailySend = await collectDueReminders({ asOf: '2026-08-23T01:00:00.000Z', db, directory });
	assert.deepEqual(dailySend.map((item) => [item.periodId, item.periodLabel, item.scheduledFor]), [
		['period-48', '提前 2 天（09:00）', '2026-08-23T01:00:00.000Z']
	]);

	const early = await collectDueReminders({ asOf: '2026-08-24T09:00:00.000Z', db, directory });
	assert.deepEqual(early.map((item) => [item.targetId, item.periodId, item.periodLabel]), [
		['selected-task', 'period-48', '提前 2 天（09:00）'],
		['selected-task', 'period-36', '提前 1 天 12 小时']
	]);
	assert.deepEqual(early[0].recipients, ['assignee@example.com']);

	const later = await collectDueReminders({ asOf: '2026-08-24T11:00:00.000Z', db, directory });
	assert.deepEqual(later.map((item) => item.periodId), ['period-48', 'period-36', 'period-6']);
	assert.equal(later.every((item) => item.targetId === 'selected-task'), true);
});

test('scheduled reminder check uses the cron instant and always closes its Hyperdrive connection', async () => {
	const calls = [];
	let closed = false;
	const database = { async close() { closed = true; } };
	const env = {
		HYPERDRIVE: { connectionString: 'postgres://example.invalid/financing' },
		RESEND_API_KEY: 'test-key',
		FROM_EMAIL: 'reminders@example.com'
	};

	const summary = await runScheduledReminderCheck({
		scheduledTime: Date.parse('2026-08-24T01:00:00.000Z'),
		env,
		createDatabase(connectionString, applicationName) {
			calls.push({ connectionString, applicationName });
			return database;
		},
		async send(options) {
			assert.equal(options.asOf.toISOString(), '2026-08-24T01:00:00.000Z');
			assert.equal(options.db, database);
			assert.equal(options.config, env);
			return {
				asOf: options.asOf.toISOString(),
				count: 3,
				dryRun: false,
				results: [{ status: 'sent' }, { status: 'sent' }, { status: 'skipped' }]
			};
		}
	});

	assert.deepEqual(calls, [{
		connectionString: env.HYPERDRIVE.connectionString,
		applicationName: 'eastmoney-financing-reminders-cron'
	}]);
	assert.equal(closed, true);
	assert.deepEqual(summary, {
		event: 'reminders.cron.completed',
		asOf: '2026-08-24T01:00:00.000Z',
		count: 3,
		dryRun: false,
		statuses: { sent: 2, skipped: 1 }
	});

	closed = false;
	await assert.rejects(
		runScheduledReminderCheck({
			scheduledTime: Date.parse('2026-08-24T02:00:00.000Z'),
			env,
			createDatabase: () => database,
			send: async () => { throw new Error('send failed'); }
		}),
		/send failed/
	);
	assert.equal(closed, true);
});
