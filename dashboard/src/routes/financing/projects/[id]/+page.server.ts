import { activePerson, getDirectory } from '$lib/server/directory';
import { randomUUID } from 'node:crypto';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { parseTaskSchedule } from '$lib/financing/sop-schedule.js';
import { refreshProjectStart } from '$lib/server/financing/project-schedule.js';
import { getDatabase } from '$lib/server/financing/db.js';

const PROJECT_STATUSES = new Set(['planning', 'in_progress', 'at_risk', 'completed', 'cancelled']);
const TASK_STATUSES = new Set(['not_started', 'in_progress', 'blocked', 'completed']);

async function resolveProjectId(rawId: string) {
	const db = getDatabase();
	const exact = await db.prepare('SELECT id FROM projects WHERE id = ?').get(rawId) as { id: string } | undefined;
	if (exact) return exact.id;

	const index = Number(rawId);
	if (!Number.isInteger(index) || index < 1) return null;
	const legacy = await db.prepare(`
		SELECT id FROM projects
		ORDER BY COALESCE(planned_start_date, planned_issue_date), name
		LIMIT 1 OFFSET ?
	`).get(index - 1) as { id: string } | undefined;
	return legacy?.id ?? null;
}

async function loadProject(projectId: string) {
	const db = getDatabase();
	const row = await db.prepare(`
		SELECT p.id, p.code, p.name, p.debt_type AS debtType, p.borrower, p.amount, p.currency,
			p.status, p.planned_start_date AS plannedStartDate, p.planned_issue_date AS plannedIssueDate,
			p.planned_maturity_date AS plannedMaturityDate, p.notes, p.created_at AS createdAt,
			p.updated_at AS updatedAt, p.owner_id AS ownerId,
			p.expected_rate_min AS expectedRateMin, p.expected_rate_max AS expectedRateMax,
			p.funding_cost_rate AS fundingCostRate, p.tenor_description AS tenorDescription,
			p.amount_description AS amountDescription,
			st.name AS sopName,
			COALESCE((
				SELECT jsonb_agg(jsonb_build_object(
					'id', pt.id, 'name', pt.name, 'status', pt.status,
					'assigneeId', pt.assignee_id,
					'scheduleType', pt.schedule_type,
					'plannedStartDate', CASE WHEN pt.schedule_type = 'period' THEN pt.planned_start_date END, 'dueDate', pt.due_date,
					'completedAt', pt.completed_at, 'sortOrder', pt.sort_order,
					'notes', COALESCE(pt.notes, node.description), 'updatedAt', pt.updated_at
				) ORDER BY pt.sort_order, pt.due_date, pt.name)
				FROM project_tasks pt
				LEFT JOIN sop_nodes node ON node.id = pt.sop_node_id
				WHERE pt.project_id = p.id
			), '[]'::jsonb) AS tasks
		FROM projects p
		LEFT JOIN sop_templates st ON st.id = p.sop_template_id
		WHERE p.id = ?
	`).get(projectId);
	if (!row) return null;
	const { tasks = [], ...project } = row as any;
 const directory = await getDirectory().people();
 const people = directory.filter(person => person.active || person.id === project.ownerId || tasks.some((task: any) => task.assigneeId === person.id));
 project.ownerName = directory.find(person => person.id === project.ownerId)?.name ?? (project.ownerId ? '已移除账号' : null);
 for (const task of tasks) task.assigneeName = directory.find(person => person.id === task.assigneeId)?.name ?? (task.assigneeId ? '已移除账号' : null);

	const membersById = new Map<string, { id: string; name: string; email: string; roles: Array<{ id: string; name: string }>; responsibility: string }>();
	if ((project as { ownerId?: string }).ownerId) {
		const owner = people.find((person: any) => person.id === (project as any).ownerId) as any;
		if (owner) membersById.set(owner.id, { ...owner, responsibility: '项目负责人' });
	}
	for (const task of tasks as any[]) {
		if (!task.assigneeId || membersById.has(task.assigneeId)) continue;
		const person = people.find((candidate: any) => candidate.id === task.assigneeId) as any;
		if (person) membersById.set(person.id, { ...person, responsibility: '任务执行人' });
	}

	return {
		project,
		tasks,
		people,
		members: [...membersById.values()]
	};
}

export const load: PageServerLoad = async ({ params }) => {
	const direct = await loadProject(params.id);
	if (direct) return direct;
	const legacyIndex = Number(params.id);
	if (!Number.isInteger(legacyIndex) || legacyIndex < 1) throw error(404, '项目不存在');
	const legacy = await getDatabase().prepare(`
		SELECT id FROM projects
		ORDER BY COALESCE(planned_start_date, planned_issue_date), name
		LIMIT 1 OFFSET ?
	`).get(legacyIndex - 1) as { id: string } | undefined;
	if (!legacy) throw error(404, '项目不存在');
	const result = await loadProject(legacy.id);
	if (!result) throw error(404, '项目不存在');
	return result;
};

export const actions: Actions = {
	updateProject: async (event) => {
		const { request, params } = event;
		const projectId = await resolveProjectId(params.id);
		if (!projectId) return fail(404, { message: '项目不存在' });
		const data = await request.formData();
		const status = String(data.get('status') ?? '');
		const ownerId = String(data.get('ownerId') ?? '');
		const notes = String(data.get('notes') ?? '').trim();
		if (!PROJECT_STATUSES.has(status)) return fail(400, { message: '项目状态无效' });
		const db = getDatabase();
		if (ownerId && !await activePerson(ownerId)) {
			return fail(400, { message: '负责人不存在或已停用' });
		}
		const before = await db.prepare('SELECT status, owner_id AS ownerId, notes FROM projects WHERE id = ?').get(projectId);
		if (!before) return fail(404, { message: '项目不存在' });
		let project;
		await db.transaction(async (transaction: ReturnType<typeof getDatabase>) => {
			project = await transaction.prepare(`
				UPDATE projects SET status = ?, owner_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ?
				RETURNING status, owner_id AS ownerId, notes, updated_at AS updatedAt
			`).get(status, ownerId || null, notes || null, projectId);
		});
		return {
			success: true,
			message: '项目状态与负责人已更新',
			project,
			refreshReminders:
				(before as any).status !== status ||
				((before as any).ownerId ?? null) !== (ownerId || null)
		};
	},
	updateTask: async (event) => {
		const { request, params } = event;
		const projectId = await resolveProjectId(params.id);
		if (!projectId) return fail(404, { message: '项目不存在' });
		const data = await request.formData();
		const taskId = String(data.get('taskId') ?? '');
		const status = String(data.get('status') ?? '');
		const assigneeId = String(data.get('assigneeId') ?? '');
		const schedule = parseTaskSchedule(data);
		if ('error' in schedule) return fail(400, { message: schedule.error });
		const { scheduleType, plannedStartDate, dueDate } = schedule;
		if (!taskId || !TASK_STATUSES.has(status)) return fail(400, { message: '任务参数无效' });
		const db = getDatabase();
		if (assigneeId && !await activePerson(assigneeId)) {
			return fail(400, { message: '任务负责人不存在或已停用' });
		}
		const selectState = db.prepare(`
			SELECT id, name, status, assignee_id AS assigneeId, due_date AS dueDate, completed_at AS completedAt
			FROM project_tasks WHERE id = ? AND project_id = ?
		`);
		const before = await selectState.get(taskId, projectId) as any;
		if (!before) return fail(404, { message: '任务节点不存在' });
		let task;
		let project;
		await db.transaction(async (transaction: ReturnType<typeof getDatabase>) => {
			task = await transaction.prepare(`
				UPDATE project_tasks
				SET status = ?, assignee_id = ?, due_date = ?, planned_start_date = ?, schedule_type = ?,
					completed_at = CASE
						WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
						ELSE NULL
					END,
					updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND project_id = ?
				RETURNING id, name, status, assignee_id AS assigneeId,
					schedule_type AS scheduleType,
					CASE WHEN schedule_type = 'period' THEN planned_start_date END AS plannedStartDate, due_date AS dueDate,
					completed_at AS completedAt, sort_order AS sortOrder, notes,
					updated_at AS updatedAt
			`).get(status, assigneeId || null, dueDate, plannedStartDate, scheduleType, status, taskId, projectId);
			project = await refreshProjectStart(transaction, projectId);
		});
		return {
			success: true,
			message: '任务节点已更新',
			task,
			project,
			refreshReminders:
				before.status !== status ||
				(before.assigneeId ?? null) !== (assigneeId || null) ||
				(before.dueDate ?? null) !== (dueDate || null)
		};
	},
	updateOwnTaskStatus: async (event) => {
		const { request, params } = event;
		const personId = event.locals.user?.auth0Id;
		if (!personId) return fail(401, { message: '请先登录' });
		const projectId = await resolveProjectId(params.id);
		if (!projectId) return fail(404, { message: '项目不存在' });
		const data = await request.formData();
		const taskId = String(data.get('taskId') ?? '');
		const status = String(data.get('status') ?? '');
		if (!taskId || !TASK_STATUSES.has(status)) return fail(400, { message: '任务参数无效' });

		const db = getDatabase();
		const before = await db.prepare(`
			SELECT id, name, status, assignee_id AS assigneeId, due_date AS dueDate,
				completed_at AS completedAt
			FROM project_tasks WHERE id = ? AND project_id = ?
		`).get(taskId, projectId) as any;
		if (!before) return fail(404, { message: '任务节点不存在' });
		if (before.assigneeId !== personId) return fail(403, { message: '仅可更新分配给自己的任务节点状态' });

		let task;
		await db.transaction(async (transaction: ReturnType<typeof getDatabase>) => {
			task = await transaction.prepare(`
				UPDATE project_tasks
				SET status = ?,
					completed_at = CASE
						WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
						ELSE NULL
					END,
					updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND project_id = ? AND assignee_id = ?
				RETURNING id, name, status, assignee_id AS assigneeId,
					schedule_type AS scheduleType,
					CASE WHEN schedule_type = 'period' THEN planned_start_date END AS plannedStartDate, due_date AS dueDate,
					completed_at AS completedAt, sort_order AS sortOrder, notes,
					updated_at AS updatedAt
			`).get(status, status, taskId, projectId, personId);
			if (!task) return;
		});
		if (!task) return fail(409, { message: '任务负责人已变化，请刷新页面后重试' });
		return {
			success: true,
			message: '任务节点状态已更新',
			task,
			refreshReminders: before.status !== status
		};
	},
	addTask: async (event) => {
		const { request, params } = event;
		const projectId = await resolveProjectId(params.id);
		if (!projectId) return fail(404, { message: '项目不存在' });
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const assigneeId = String(data.get('assigneeId') ?? '');
		const schedule = parseTaskSchedule(data);
		if ('error' in schedule) return fail(400, { message: schedule.error });
		const { scheduleType, plannedStartDate, dueDate } = schedule;
		if (!name || name.length > 120) return fail(400, { message: '请输入 1–120 个字符的任务名称' });
		const db = getDatabase();
		if (assigneeId && !await activePerson(assigneeId)) {
			return fail(400, { message: '任务负责人不存在或已停用' });
		}
		const nextOrder = (await db.prepare(`
			SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder
			FROM project_tasks WHERE project_id = ?
		`).get(projectId) as { nextOrder: number }).nextOrder;
		const taskId = randomUUID();
		let project;
		await db.transaction(async (transaction: ReturnType<typeof getDatabase>) => {
			await transaction.prepare(`
				INSERT INTO project_tasks (
					id, project_id, name, status, assignee_id, due_date, planned_start_date, schedule_type, sort_order
				) VALUES (?, ?, ?, 'not_started', ?, ?, ?, ?, ?)
			`).run(taskId, projectId, name, assigneeId || null, dueDate, plannedStartDate, scheduleType, nextOrder);
			project = await refreshProjectStart(transaction, projectId);
		});
		return {
			success: true,
			message: '任务节点已添加',
			project,
			task: {
				id: taskId,
				name,
				status: 'not_started',
				assigneeId: assigneeId || null,
				assigneeName: null,
				scheduleType,
				plannedStartDate,
				dueDate: dueDate || null,
				completedAt: null,
				sortOrder: nextOrder,
				notes: null
			},
			refreshReminders: true
		};
	}
};
