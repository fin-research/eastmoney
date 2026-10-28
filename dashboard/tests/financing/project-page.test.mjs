import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectPageData } from '../../src/lib/financing/project-page.js';

const first = {
	id: 'p1',
	code: 'FIN-1',
	name: '一期项目',
	debtType: '公司债',
	status: 'planning',
	plannedStartDate: '2026-08-10',
	plannedIssueDate: '2026-08-20',
	ownerId: 'owner-1',
	ownerName: '甲',
	tasks: [
		{ id: 't1', name: '簿记', status: 'not_started', plannedStartDate: '2026-08-10', dueDate: '2026-08-20', assigneeName: '乙' }
	]
};

test('one changed project source recalculates the whole local Gantt view', () => {
	const second = {
		...first,
		id: 'p2',
		code: 'FIN-2',
		name: '二期项目',
		plannedStartDate: '2026-09-01',
		plannedIssueDate: '2026-09-15',
		tasks: []
	};
	const initial = buildProjectPageData([first, second], '2026-08-24');
	const changed = {
		...first,
		plannedStartDate: '2026-07-15',
		plannedIssueDate: '2026-07-31',
		tasks: [{ ...first.tasks[0], plannedStartDate: '2026-07-15', dueDate: '2026-07-31' }]
	};
	const updated = buildProjectPageData([changed, second], '2026-08-24');

	assert.equal(initial.timeline.start, '2026-08-01');
	assert.equal(updated.timeline.start, '2026-07-01');
	assert.ok(updated.projects.find((project) => project.id === 'p2').startPct > initial.projects.find((project) => project.id === 'p2').startPct);
	assert.equal(updated.projects.find((project) => project.id === 'p1').plannedBookbuildingDate, '2026-07-31');
});
