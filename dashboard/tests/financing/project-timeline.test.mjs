import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectTimeline, positionInTimeline, widthInTimeline } from '../../src/lib/financing/project-timeline.js';

test('project timeline follows current project and task dates instead of fixed months', () => {
	const timeline = buildProjectTimeline([
		{
			plannedStartDate: '2026-07-20',
			plannedIssueDate: '2026-08-31',
			tasks: [{ plannedStartDate: '2026-08-20', dueDate: '2026-09-15' }]
		}
	], '2026-08-23');

	assert.equal(timeline.start, '2026-07-01');
	assert.equal(timeline.end, '2026-09-30');
	assert.deepEqual(timeline.months.map((band) => band.label), ['2026年7月', '2026年8月', '2026年9月']);
	assert.ok(timeline.todayPct > timeline.months[0].widthPct);
	assert.ok(positionInTimeline('2026-09-15', timeline) > timeline.todayPct);
	assert.ok(widthInTimeline('2026-08-20', '2026-09-15', timeline) > 20);
	assert.ok(Math.abs(timeline.months.reduce((sum, band) => sum + band.widthPct, 0) - 100) < 0.0001);
});

test('empty project timeline still centers on the real current month', () => {
	const timeline = buildProjectTimeline([], '2027-02-11');
	assert.equal(timeline.start, '2027-02-01');
	assert.equal(timeline.end, '2027-02-28');
	assert.deepEqual(timeline.months.map((band) => band.label), ['2027年2月']);
	assert.ok(timeline.todayPct > 0 && timeline.todayPct < 100);
});
