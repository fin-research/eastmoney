import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parseSopSchedule, parseTaskSchedule, resolveSopSchedule, projectStartDate, isScheduleDate } from '../../src/lib/financing/sop-schedule.js';
import { buildProjectPageData } from '../../src/lib/financing/project-page.js';

function form(values) {
	const data = new FormData();
	for (const [key, value] of Object.entries(values)) data.set(key, String(value));
	return data;
}

test('schedule form switches modes, blocks incomplete periods and resets after creation', async () => {
	await promisify(execFile)(process.execPath, ['--conditions=browser', 'tests/helpers/financing-schedule-fields.mjs'], {
		cwd: new URL('../../', import.meta.url), timeout: 20_000, maxBuffer: 20_000
	});
});

test('SOP point compatibility, period validation and switching back to point', () => {
	assert.deepEqual(parseSopSchedule(form({ offsetDays: -3 })), { offsetDays: -3, startOffsetDays: null });
	assert.deepEqual(parseSopSchedule(form({ scheduleType: 'period', startOffsetDays: -10, offsetDays: -3 })), { offsetDays: -3, startOffsetDays: -10 });
	assert.deepEqual(parseSopSchedule(form({ scheduleType: 'period', startOffsetDays: 0, offsetDays: 0 })), { offsetDays: 0, startOffsetDays: 0 });
	assert.deepEqual(parseSopSchedule(form({ scheduleType: 'point', startOffsetDays: -10, offsetDays: -3 })), { offsetDays: -3, startOffsetDays: null });
	for (const values of [
		{ offsetDays: '' }, { offsetDays: -3651 }, { offsetDays: 3651 }, { offsetDays: 0.5 },
		{ scheduleType: 'unknown', offsetDays: 0 },
		{ scheduleType: 'period', startOffsetDays: '', offsetDays: 0 },
		{ scheduleType: 'period', startOffsetDays: -3651, offsetDays: 0 },
		{ scheduleType: 'period', startOffsetDays: 1, offsetDays: 0 }
	]) assert.ok(parseSopSchedule(form(values)).error, JSON.stringify(values));
});

test('period dates use calendar days across weekends, leap days and year boundaries', () => {
	assert.deepEqual(resolveSopSchedule('2026-01-05', { startOffsetDays: -10, offsetDays: -3 }), {
		scheduleType: 'period', plannedStartDate: '2025-12-26', dueDate: '2026-01-02'
	});
	assert.deepEqual(resolveSopSchedule('2028-03-01', { offsetDays: -1 }), {
		scheduleType: 'point', plannedStartDate: null, dueDate: '2028-02-29'
	});
	assert.equal(projectStartDate('2026-09-10', [
		{ offsetDays: -3 }, { startOffsetDays: -10, offsetDays: 2 }
	]), '2026-08-31');
	assert.throws(() => resolveSopSchedule('9999-12-31', { offsetDays: 1 }), /范围/);
});

test('task periods require real, ordered dates; points may remain unscheduled', () => {
	assert.deepEqual(parseTaskSchedule(form({ scheduleType: 'period', plannedStartDate: '2026-09-08', dueDate: '2026-09-10' })), {
		scheduleType: 'period', plannedStartDate: '2026-09-08', dueDate: '2026-09-10'
	});
	assert.deepEqual(parseTaskSchedule(form({ dueDate: '' })), { scheduleType: 'point', plannedStartDate: null, dueDate: null });
	assert.equal(parseTaskSchedule(form({ scheduleType: 'point', plannedStartDate: '2026-09-11', dueDate: '2026-09-10' })).plannedStartDate, null);
	for (const [start, end] of [['', '2026-09-10'], ['2026-09-08', ''], ['2026-09-11', '2026-09-10'], ['2026-02-29', '2026-03-01']]) {
		assert.ok(parseTaskSchedule(form({ scheduleType: 'period', plannedStartDate: start, dueDate: end })).error);
	}
	assert.equal(isScheduleDate('2028-02-29'), true);
	for (const date of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-9-8']) assert.equal(isScheduleDate(date), false);
});

test('Gantt uses each task interval, places points at their date and covers post-bookbuilding work', () => {
	const view = buildProjectPageData([{
		id: 'p', status: 'planning', plannedStartDate: '2026-09-01', plannedIssueDate: '2026-09-10',
		tasks: [
			{ name: '期末交付', scheduleType: 'period', plannedStartDate: '2026-09-08', dueDate: '2026-10-05' },
			{ name: '单点', scheduleType: 'point', plannedStartDate: null, dueDate: '2026-09-10' },
			{ name: '待安排', scheduleType: 'point', plannedStartDate: null, dueDate: null }
		]
	}], '2026-09-08');
	assert.equal(view.timeline.end, '2026-10-31');
	assert.equal(view.projects[0].end, '2026-10-05');
	const [period, point, unscheduled] = view.projects[0].tasks;
	assert.ok(point.startPct > period.startPct);
	assert.ok(period.widthPct > point.widthPct);
	assert.equal(unscheduled.hasSchedule, false);
});

test('migration preserves historical dates and rejects incomplete or reversed periods', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await db.exec(`
		CREATE SCHEMA financing;
		CREATE TABLE financing.sop_nodes (id text PRIMARY KEY, default_offset_days integer NOT NULL);
		CREATE TABLE financing.project_tasks (id text PRIMARY KEY, planned_start_date date, due_date date);
		INSERT INTO financing.sop_nodes VALUES ('node', -3);
		INSERT INTO financing.project_tasks VALUES ('legacy', '2026-08-01', '2026-09-08');
	`);
	const migration = await readFile(new URL('../../financing-migrations/0033_sop_schedule_periods.sql', import.meta.url), 'utf8');
	// Applying inside a transaction can be fully rolled back.
	const body = migration.replace(/^BEGIN;/, '').replace(/COMMIT;\s*$/, '');
	await db.exec(`BEGIN; ${body} ROLLBACK;`);
	assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='financing' AND column_name='schedule_type'")).rows[0].n, 0);
	await db.exec(migration);
	assert.deepEqual((await db.query("SELECT schedule_type, planned_start_date::text, due_date::text FROM financing.project_tasks WHERE id='legacy'")).rows[0], {
		schedule_type: 'point', planned_start_date: '2026-08-01', due_date: '2026-09-08'
	});
	assert.equal((await db.query("SELECT default_start_offset_days FROM financing.sop_nodes WHERE id='node'")).rows[0].default_start_offset_days, null);
	await assert.rejects(db.exec("UPDATE financing.sop_nodes SET default_start_offset_days=0"), /sop_nodes_schedule_period_check/);
	await db.exec("UPDATE financing.sop_nodes SET default_start_offset_days=-10");
	await assert.rejects(db.exec("INSERT INTO financing.project_tasks VALUES ('invalid', NULL, '2026-09-10', 'period')"), /project_tasks_schedule_period_check/);
	await assert.rejects(db.exec("INSERT INTO financing.project_tasks VALUES ('reverse', '2026-09-11', '2026-09-10', 'period')"), /project_tasks_schedule_period_check/);
	await db.exec("INSERT INTO financing.project_tasks VALUES ('same-day', '2026-09-10', '2026-09-10', 'period')");
});
