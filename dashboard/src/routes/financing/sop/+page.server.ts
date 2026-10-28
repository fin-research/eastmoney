import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/financing/db.js';
import { getWorkflowSettingsData } from '$lib/server/financing/queries.js';
import { parseReminderPeriods } from '$lib/financing/reminder-periods.js';
import { hasPermission } from '$lib/permissions';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async () => ({
	settings: await getWorkflowSettingsData()
});

export const actions: Actions = {
	createReminder: async (event) => {
		if (!hasPermission(event.locals.permissions, "financing.reminder:create")) return fail(403,{message:"无权新增提醒"});
		const data = await event.request.formData();
		const name = String(data.get('name') ?? '').trim();
		const recipientMode = String(data.get('recipientMode') ?? 'assignee');
		const recipients = String(data.get('recipients') ?? '').trim();
		const customRecipients = recipients.split(/[;,，；\s]+/).filter(Boolean);
		const nodeIds = [...new Set(data.getAll('nodeIds').map(String).map((id) => id.trim()).filter(Boolean))];
		const parsedPeriods = parseReminderPeriods(data.getAll('periodDays'), data.getAll('periodHours'));
		if (!name || name.length > 120) return fail(400, { message: '规则名称应为 1–120 个字符' });
		if (!nodeIds.length || nodeIds.length > 100) return fail(400, { message: '请选择 1–100 个 SOP 节点' });
		if ('error' in parsedPeriods) return fail(400, { message: parsedPeriods.error });
		if (!['assignee', 'owner', 'custom'].includes(recipientMode)) return fail(400, { message: '收件人类型无效' });
		if (recipientMode === 'custom') {
			if (!customRecipients.length || customRecipients.some((email) => !emailPattern.test(email))) {
				return fail(400, { message: '请填写有效的指定收件邮箱' });
			}
		}
		const db = getDatabase();
		const selectedNodes = await db.prepare(`
			SELECT node.id, node.name, template.id AS sopId, template.name AS sopName,
				template.debt_type AS debtType
			FROM sop_nodes node
			JOIN sop_templates template ON template.id = node.template_id
			JOIN jsonb_to_recordset(?::jsonb) AS selected(id text) ON selected.id = node.id
			WHERE template.is_active = TRUE
			ORDER BY template.debt_type, template.name, node.sort_order, node.created_at, node.id
		`).all(JSON.stringify(nodeIds.map((id) => ({ id })))) as Array<{
			id: string;
			name: string;
			sopId: string;
			sopName: string;
			debtType: string;
		}>;
		if (selectedNodes.length !== nodeIds.length) {
			return fail(409, { message: '所选 SOP 节点已变化或模板已停用，请重新选择' });
		}
		const id = randomUUID();
		const periodRows = parsedPeriods.periods.map((period) => ({ id: randomUUID(), ...period }));
		await db.batch([
			db.prepare(`
				INSERT INTO reminder_rules (
					id, name, channel, recipient_mode, recipients, is_active
				) VALUES (?, ?, 'email', ?, ?, TRUE)
			`).bind(
				id,
				name,
				recipientMode,
				recipientMode === 'custom' ? JSON.stringify(customRecipients) : null
			),
			db.prepare(`
				INSERT INTO reminder_rule_nodes (rule_id, sop_node_id)
				SELECT ?::text, source.sop_node_id
				FROM jsonb_to_recordset(?::jsonb) AS source(sop_node_id text)
			`).bind(id, JSON.stringify(selectedNodes.map((node) => ({ sop_node_id: node.id })))),
			db.prepare(`
				INSERT INTO reminder_rule_periods (id, rule_id, lead_hours, sort_order)
				SELECT source.id, ?::text, source.lead_hours, source.sort_order
				FROM jsonb_to_recordset(?::jsonb) AS source(id text, lead_hours integer, sort_order integer)
			`).bind(id, JSON.stringify(periodRows.map((period) => ({
				id: period.id,
				lead_hours: period.leadHours,
				sort_order: period.sortOrder
			}))))]);
		return {
			success: true,
			message: '提醒规则已保存',
			reminderRule: {
				id,
				name,
				channel: 'email',
				recipientMode,
				recipients: recipientMode === 'custom' ? customRecipients : null,
				targets: selectedNodes,
				periods: periodRows.map(({ id: periodId, leadHours, sortOrder }) => ({
					id: periodId,
					leadHours,
					sortOrder
				})),
				isActive: true
			}
		};
	},
	createSop: async (event) => {
		if (!hasPermission(event.locals.permissions, 'financing.sop:create')) {
			return fail(403, { message: '当前角色无权新增 SOP' });
		}
		const data = await event.request.formData();
		const name = String(data.get('name') ?? '').trim();
		const debtType = String(data.get('debtType') ?? '').trim();
		const description = String(data.get('description') ?? '').trim();
		if (!name || !debtType) return fail(400, { message: '请填写 SOP 名称和负债品种' });
		const db = getDatabase();
		const id = randomUUID();
		try {
			await db.batch([db.prepare(`
				INSERT INTO sop_templates (id, name, debt_type, description)
				VALUES (?, ?, ?, ?)
			`).bind(id, name, debtType, description || null)]);
		} catch (error) {
			return fail(409, { message: error instanceof Error ? error.message : String(error) });
		}
		return {
			success: true,
			message: 'SOP 模板已创建',
			sopId: id,
			sopTemplate: {
				id,
				name,
				debtType,
				description: description || null,
				isActive: true,
				nodeCount: 0
			}
		};
	}
};
