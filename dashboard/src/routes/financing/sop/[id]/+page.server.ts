import { getDirectory } from '$lib/server/directory';
import { randomUUID } from 'node:crypto';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/financing/db.js';
import { parseSopSchedule } from '$lib/financing/sop-schedule.js';
import { hasSameOrder, isCompleteReorder } from '$lib/financing/reorder-items.js';

const MAX_NODE_NAME = 120;

async function templateExists(id: string) {
	return getDatabase().prepare('SELECT 1 FROM sop_templates WHERE id = ?').get(id);
}

async function loadTemplate(id: string) {
	const template = await getDatabase().prepare(`
		SELECT id, name, debt_type AS debtType, description, is_active AS isActive,
			created_at AS createdAt, updated_at AS updatedAt
		FROM sop_templates WHERE id = ?
	`).get(id) as any;
	return template ? { ...template, isActive: Boolean(template.isActive) } : null;
}

async function loadNodes(templateId: string) {
	return await getDatabase().prepare(`
		SELECT id, name, description, sort_order AS sortOrder,
			default_offset_days AS offsetDays, default_start_offset_days AS startOffsetDays, default_owner_role AS ownerRole
		FROM sop_nodes WHERE template_id = ? ORDER BY sort_order, created_at, id
	`).all(templateId) as Array<{
		id: string;
		name: string;
		description: string | null;
		sortOrder: number;
		offsetDays: number;
		startOffsetDays: number | null;
		ownerRole: string | null;
	}>;
}

async function loadSopDetail(id: string) {
	const row = await getDatabase().prepare(`
		SELECT template.id, template.name, template.debt_type AS debtType,
			template.description, template.is_active AS isActive,
			template.created_at AS createdAt, template.updated_at AS updatedAt,
			COALESCE((
				SELECT jsonb_agg(jsonb_build_object(
					'id', node.id, 'name', node.name, 'description', node.description,
					'sortOrder', node.sort_order, 'offsetDays', node.default_offset_days,
					'startOffsetDays', node.default_start_offset_days,
					'ownerRole', node.default_owner_role
				) ORDER BY node.sort_order, node.created_at, node.id)
				FROM sop_nodes node WHERE node.template_id = template.id
			), '[]'::jsonb) AS nodes
		FROM sop_templates template WHERE template.id = ?
	`).get(id) as any;
	if (!row) return null;
	const { nodes = [], ...template } = row;
	return { template: { ...template, isActive: Boolean(template.isActive) }, nodes };
}

async function parseNode(data: FormData) {
	const name = String(data.get('name') ?? '').trim();
	const description = String(data.get('description') ?? '').trim();
	const ownerRole = String(data.get('ownerRole') ?? '').trim();
	const schedule = parseSopSchedule(data);
	if (!name || name.length > MAX_NODE_NAME) return { error: '节点名称应为 1–120 个字符' } as const;
	if ('error' in schedule) return schedule;
	if (ownerRole.length > 80) return { error: '默认角色不能超过 80 个字符' } as const;
	if (ownerRole && !(await getDirectory().roles()).some(role => role.id === ownerRole)) return { error: '请选择有效的 Auth0 角色' } as const;
	return { name, description, ownerRole, ...schedule } as const;
}

export const load: PageServerLoad = async ({ params }) => {
	const detail = await loadSopDetail(params.id);
	if (!detail) throw error(404, 'SOP 模板不存在');
	const roles = (await getDirectory().roles()).map(role => ({ code: role.id, label: role.name }));
	return {
		...detail,
		roles
	};
};

export const actions: Actions = {
	updateTemplate: async (event) => {
		const { request, params } = event;
		if (!await templateExists(params.id)) return fail(404, { message: 'SOP 模板不存在' });
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const debtType = String(data.get('debtType') ?? '').trim();
		const description = String(data.get('description') ?? '').trim();
		if (!name || name.length > 120 || !debtType || debtType.length > 80) {
			return fail(400, { message: '请填写有效的 SOP 名称和负债品种' });
		}
		try {
			const db = getDatabase();
			const selectState = db.prepare('SELECT name, debt_type AS debtType, description FROM sop_templates WHERE id = ?');
			const before = await selectState.get(params.id);
			await db.batch([
				db.prepare(`
					UPDATE sop_templates
					SET name = ?, debt_type = ?, description = ?, updated_at = CURRENT_TIMESTAMP
					WHERE id = ?
				`).bind(name, debtType, description || null, params.id)]);
			return {
				success: true,
				message: 'SOP 基本信息已保存',
				template: await loadTemplate(params.id)
			};
		} catch (cause) {
			return fail(409, { message: cause instanceof Error ? cause.message : '同品种下已存在同名 SOP' });
		}
	},
	toggleTemplate: async (event) => {
		const { params } = event;
		if (!await templateExists(params.id)) return fail(404, { message: 'SOP 模板不存在' });
		const db = getDatabase();
		const before = await db.prepare('SELECT name, is_active AS isActive FROM sop_templates WHERE id = ?').get(params.id) as any;
		const after = { ...before, isActive: before.isActive ? 0 : 1 };
		await db.batch([
			db.prepare(`
				UPDATE sop_templates
				SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
				WHERE id = ?
			`).bind(params.id)]);
		return {
			success: true,
			message: 'SOP 启停状态已更新',
			isActive: Boolean(after.isActive),
			refreshReminders: true
		};
	},
	addNode: async (event) => {
		const { request, params } = event;
		if (!await templateExists(params.id)) return fail(404, { message: 'SOP 模板不存在' });
		const parsed = await parseNode(await request.formData());
		if ('error' in parsed) return fail(400, { message: parsed.error });
		const db = getDatabase();
		const nextOrder = (await db.prepare(`
			SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder
			FROM sop_nodes WHERE template_id = ?
		`).get(params.id) as { nextOrder: number }).nextOrder;
		const nodeId = randomUUID();
		const after = {
			id: nodeId,
			name: parsed.name,
			description: parsed.description || null,
			sortOrder: nextOrder,
			offsetDays: parsed.offsetDays,
			startOffsetDays: parsed.startOffsetDays,
			ownerRole: parsed.ownerRole || null
		};
		await db.batch([
			db.prepare(`
				INSERT INTO sop_nodes (
					id, template_id, name, description, sort_order,
					default_offset_days, default_start_offset_days, default_owner_role
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(nodeId, params.id, parsed.name, parsed.description || null, nextOrder, parsed.offsetDays, parsed.startOffsetDays, parsed.ownerRole || null)]);
		return { success: true, message: 'SOP 节点已添加', node: after };
	},
	updateNode: async (event) => {
		const { request, params } = event;
		if (!await templateExists(params.id)) return fail(404, { message: 'SOP 模板不存在' });
		const data = await request.formData();
		const nodeId = String(data.get('nodeId') ?? '');
		const parsed = await parseNode(data);
		if ('error' in parsed) return fail(400, { message: parsed.error });
		const db = getDatabase();
		if (!await db.prepare('SELECT 1 FROM sop_nodes WHERE id = ? AND template_id = ?').get(nodeId, params.id)) {
			return fail(404, { message: 'SOP 节点不存在' });
		}
		const selectState = db.prepare(`
			SELECT id, name, description, sort_order AS sortOrder,
				default_offset_days AS offsetDays, default_start_offset_days AS startOffsetDays, default_owner_role AS ownerRole
			FROM sop_nodes WHERE id = ? AND template_id = ?
		`);
		const before = await selectState.get(nodeId, params.id);
		await db.batch([
			db.prepare(`
				UPDATE sop_nodes
				SET name = ?, description = ?, default_offset_days = ?, default_start_offset_days = ?,
					default_owner_role = ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND template_id = ?
			`).bind(parsed.name, parsed.description || null, parsed.offsetDays, parsed.startOffsetDays, parsed.ownerRole || null, nodeId, params.id)]);
		return {
			success: true,
			message: 'SOP 节点已更新',
			node: {
				...before,
				name: parsed.name,
				description: parsed.description || null,
				offsetDays: parsed.offsetDays,
				startOffsetDays: parsed.startOffsetDays,
				ownerRole: parsed.ownerRole || null
			}
		};
	},
	reorderNodes: async (event) => {
		const { request, params } = event;
		if (!await templateExists(params.id)) return fail(404, { message: 'SOP 模板不存在' });
		const data = await request.formData();
		const proposedIds = String(data.get('orderedNodeIds') ?? '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		const db = getDatabase();
		const currentNodes = await loadNodes(params.id);
		const currentIds = currentNodes.map((node) => node.id);
		if (!isCompleteReorder(currentIds, proposedIds)) {
			return fail(409, { message: '节点列表已变化，请刷新后重试排序' });
		}
		if (hasSameOrder(currentIds, proposedIds)) {
			return { success: true, message: '节点顺序没有变化', orderedNodeIds: currentIds };
		}
		await db.batch([
			...proposedIds.map((nodeId, index) => db.prepare(`
				UPDATE sop_nodes SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND template_id = ?
			`).bind(-(index + 1), nodeId, params.id)),
			...proposedIds.map((nodeId, index) => db.prepare(`
				UPDATE sop_nodes SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND template_id = ?
			`).bind(index + 1, nodeId, params.id))]);
		return { success: true, message: '节点顺序已保存', orderedNodeIds: proposedIds };
	},
	deleteNode: async (event) => {
		const { request, params } = event;
		if (!await templateExists(params.id)) return fail(404, { message: 'SOP 模板不存在' });
		const nodeId = String((await request.formData()).get('nodeId') ?? '');
		const db = getDatabase();
		const before = await db.prepare(`
			SELECT id, name, description, sort_order AS sortOrder,
				default_offset_days AS offsetDays, default_start_offset_days AS startOffsetDays, default_owner_role AS ownerRole
			FROM sop_nodes WHERE id = ? AND template_id = ?
		`).get(nodeId, params.id) as any;
		if (!before) return fail(404, { message: 'SOP 节点不存在' });
		const remaining = await db.prepare(`
			SELECT id FROM sop_nodes WHERE template_id = ? AND id != ? ORDER BY sort_order, created_at, id
		`).all(params.id, nodeId) as Array<{ id: string }>;
		await db.batch([
			db.prepare('DELETE FROM sop_nodes WHERE id = ? AND template_id = ?').bind(nodeId, params.id),
			...remaining.map((row, index) => db.prepare(
				'UPDATE sop_nodes SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
			).bind(index + 1, row.id))]);
		return {
			success: true,
			message: 'SOP 节点已删除',
			deletedNodeId: nodeId,
			orderedNodeIds: remaining.map((row) => row.id)
		};
	}
};
