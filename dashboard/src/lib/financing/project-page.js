import {
	buildProjectTimeline,
	positionInTimeline,
	widthInTimeline
} from './project-timeline.js';

/** @param {string} status */
function statusMeta(status) {
	if (status === 'completed') return { label: '已完成', tone: 'gray' };
	if (status === 'at_risk') return { label: '延期风险', tone: 'orange' };
	if (status === 'in_progress') return { label: '执行中', tone: 'blue' };
	if (status === 'cancelled') return { label: '已取消', tone: 'gray' };
	return { label: '需求确认', tone: 'teal' };
}

/** @param {string | null | undefined} date @param {string} today */
function dueText(date, today) {
	if (!date) return '待安排';
	const days = Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
	if (days === 0) return '今天';
	if (days === 1) return '明天';
	if (days > 1 && days <= 7) return `${days}天后`;
	return date.slice(5).replace('-', '月') + '日';
}

/**
 * Convert the locally-held project sources into the Gantt view. Keeping this
 * calculation in the browser lets mutation responses return one changed
 * project while still recalculating the shared timeline correctly.
 *
 * @param {Array<Record<string, any>>} sources
 * @param {string} today
 */
export function buildProjectPageData(sources, today) {
	const timeline = buildProjectTimeline(sources, today);
	const projects = sources.map((project) => {
		/** @type {Array<Record<string, any>>} */
		const tasks = project.tasks ?? [];
		const completed = tasks.filter((task) => task.status === 'completed').length;
		const progress = tasks.length
			? Math.round((completed / tasks.length) * 100)
			: project.status === 'completed' ? 100 : 0;
		const scheduledDates = tasks.flatMap((task) => [task.plannedStartDate, task.dueDate]).filter(Boolean);
		const start = [project.plannedStartDate, project.plannedIssueDate, ...scheduledDates].filter(Boolean).sort()[0] ?? today;
		const end = [project.plannedIssueDate, ...scheduledDates].filter(Boolean).sort().at(-1) ?? project.plannedMaturityDate ?? start;
		const nextTask = tasks.find((task) => task.status !== 'completed');
		const meta = statusMeta(project.status);
		const members = [...new Set([project.ownerName, ...tasks.map((task) => task.assigneeName)]
			.filter((name) => typeof name === 'string' && name.length > 0)
			.map((name) => name.slice(0, 1)))];

		return {
			id: project.id,
			code: project.code,
			name: project.name,
			type: project.debtType,
			rawStatus: project.status,
			owner: project.ownerName ?? '待分配',
			ownerId: project.ownerId ?? null,
			amount: project.amount ?? null,
			expectedRateMin: project.expectedRateMin ?? null,
			expectedRateMax: project.expectedRateMax ?? null,
			fundingCostRate: project.fundingCostRate ?? null,
			tenorDescription: project.tenorDescription ?? null,
			amountDescription: project.amountDescription ?? null,
			notes: project.notes ?? '',
			plannedBookbuildingDate: project.plannedIssueDate ?? '',
			status: meta.label,
			progress,
			start,
			end,
			startPct: positionInTimeline(start, timeline),
			widthPct: widthInTimeline(start, end, timeline, 1.5),
			tone: meta.tone,
			nextNode: nextTask?.name ?? '项目归档',
			dueText: dueText(nextTask?.dueDate ?? end, today),
			members: members.length ? members : ['待'],
			tasks: tasks.map((task) => {
				const taskStartDate = task.plannedStartDate ?? task.dueDate;
				const taskEndDate = task.dueDate ?? taskStartDate;
				return {
					name: task.name,
					scheduleType: task.scheduleType ?? (task.plannedStartDate ? 'period' : 'point'),
					plannedStartDate: task.plannedStartDate ?? null,
					dueDate: task.dueDate ?? null,
					hasSchedule: Boolean(taskStartDate),
					status: task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'doing' : 'waiting',
					startPct: positionInTimeline(taskStartDate, timeline),
					widthPct: widthInTimeline(taskStartDate, taskEndDate, timeline, 1)
				};
			})
		};
	});
	return { projects, timeline };
}
