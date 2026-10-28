// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { messengerJson } from '../messenger.ts';
import { createDirectory } from '../auth0-directory.ts';
import { reminderPeriodLabel } from '../../financing/reminder-periods.js';

function isoDate(value = new Date()) {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
	}).format(value);
}

function normaliseAsOf(asOf, asOfDate) {
	const value = asOf ?? (asOfDate ? `${asOfDate}T23:59:59+08:00` : new Date());
	const instant = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(instant.getTime())) throw new Error('提醒任务时间无效');
	return instant;
}

function recipientsFor(row) {
	if (row.recipientMode === 'owner') return row.ownerEmail ? [row.ownerEmail] : [];
	if (row.recipientMode === 'custom') {
		if (Array.isArray(row.recipients)) return row.recipients.map(String).filter(Boolean);
		return String(row.recipients ?? '')
			.split(/[;,，；\s]+/)
			.map((email) => email.trim())
			.filter(Boolean);
	}
	return row.assigneeEmail ? [row.assigneeEmail] : [];
}

function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function requireDatabase(db) {
	if (!db) throw new Error('提醒任务必须显式传入数据库连接');
	return db;
}

export async function collectDueReminders({ asOf, asOfDate, db, directory, onCandidates } = {}) {
	db = requireDatabase(db);
	const instant = normaliseAsOf(asOf, asOfDate);
	const asOfIso = instant.toISOString();
	const rows = await db.prepare(`
		WITH candidates AS (
			SELECT rule.id AS ruleId, rule.name AS ruleName,
				rule.recipient_mode AS recipientMode, rule.recipients,
				period.id AS periodId, period.lead_hours AS leadHours,
				task.id AS targetId, task.name AS taskName, project.name AS projectName,
				project.id AS projectId, project.debt_type AS debtType, template.name AS sopName, node.name AS nodeName,
				task.due_date AS triggerDate,
				(task.due_date::timestamp AT TIME ZONE 'Asia/Shanghai') AS triggerAt,
				CASE
					WHEN period.lead_hours % 24 = 0 THEN
						((task.due_date - (period.lead_hours / 24)::integer) + TIME '09:00')
							AT TIME ZONE 'Asia/Shanghai'
					ELSE (task.due_date::timestamp AT TIME ZONE 'Asia/Shanghai')
						- make_interval(hours => period.lead_hours)
				END AS scheduledFor,
				task.assignee_id AS assigneeId, project.owner_id AS ownerId
			FROM reminder_rules rule
			JOIN reminder_rule_nodes target ON target.rule_id = rule.id
			JOIN sop_nodes node ON node.id = target.sop_node_id
			JOIN sop_templates template ON template.id = node.template_id AND template.is_active = TRUE
			JOIN project_tasks task ON task.sop_node_id = node.id AND task.status <> 'completed'
			JOIN projects project ON project.id = task.project_id AND project.sop_template_id = template.id
			JOIN reminder_rule_periods period ON period.rule_id = rule.id
			WHERE rule.is_active = TRUE AND task.due_date IS NOT NULL
		)
		SELECT * FROM candidates
		WHERE scheduledFor <= ?::timestamptz
			AND ?::timestamptz < triggerAt + INTERVAL '1 day'
		ORDER BY scheduledFor, ruleId, targetId, periodId
	`).all(asOfIso, asOfIso);
	onCandidates?.(rows.length);
	const people = rows.length ? await directory() : [];
	const accounts = new Map(people.filter(person => person.active).map(person => [person.id, person]));
	const reminders = [];

	for (const row of rows) {
		const recipients = recipientsFor({ ...row, ownerEmail: accounts.get(row.ownerId)?.email, assigneeEmail: accounts.get(row.assigneeId)?.email });
		if (!recipients.length) continue;
		const leadHours = Number(row.leadHours);
		reminders.push({
			ruleId: row.ruleId,
			ruleName: row.ruleName,
			periodId: row.periodId,
			leadHours,
			periodLabel: reminderPeriodLabel(leadHours),
			targetType: 'project_task',
			targetId: row.targetId,
			projectId: row.projectId,
			unresolvedRecipients: row.recipientMode === 'custom' ? recipients.filter(email => !people.some(person => person.active && person.email.toLowerCase() === email.toLowerCase())) : [],
			userIds: row.recipientMode === 'owner' ? [row.ownerId] : row.recipientMode === 'assignee' ? [row.assigneeId] : people.filter(person => person.active && recipients.some(email => email.toLowerCase() === person.email.toLowerCase())).map(person => person.id),
			projectName: row.projectName,
			taskName: row.taskName,
			debtType: row.debtType,
			sopName: row.sopName,
			nodeName: row.nodeName,
			triggerDate: row.triggerDate,
			scheduledFor: new Date(row.scheduledFor).toISOString(),
			deliveryDate: isoDate(instant),
			recipients
		});
	}
	return reminders;
}

export async function sendDueReminders({ asOf, asOfDate, dryRun = false, db, config = process.env, directory } = {}) {
	db = requireDatabase(db);
	const instant = normaliseAsOf(asOf, asOfDate);
	let candidateCount = 0;
	const reminders = await collectDueReminders({ asOf: instant, db, directory: directory ?? (() => createDirectory(config).people()), onCandidates: count => { candidateCount = count; } });
	const messenger = config.MESSENGER;
	const results = [];
	const existingRows = reminders.length ? await db.prepare(`
		WITH keys AS (
			SELECT rule_id, target_id, period_id
			FROM jsonb_to_recordset(?::jsonb) AS source(rule_id text, target_id text, period_id text)
		)
		SELECT delivery.id, delivery.rule_id AS ruleId, delivery.target_id AS targetId,
			delivery.period_id AS periodId, delivery.status
		FROM reminder_deliveries delivery
		JOIN keys ON keys.rule_id = delivery.rule_id
			AND keys.target_id = delivery.target_id
			AND keys.period_id = delivery.period_id
	`).all(JSON.stringify(reminders.map((reminder) => ({
		rule_id: reminder.ruleId,
		target_id: reminder.targetId,
		period_id: reminder.periodId
	})))) : [];
	const existingByTarget = new Map(existingRows.map((row) => [`${row.ruleId}:${row.targetId}:${row.periodId}`, row]));
	const deliveries = [];

	for (const reminder of reminders) {
		const existing = existingByTarget.get(`${reminder.ruleId}:${reminder.targetId}:${reminder.periodId}`);
		if (['sent', 'queued'].includes(existing?.status)) {
			results.push({ ...reminder, status: 'skipped' });
			continue;
		}

		const deliveryId = existing?.id ?? randomUUID();
		if (dryRun || !messenger) {
			deliveries.push({ ...reminder, id: deliveryId, status: 'pending', providerMessageId: null, errorMessage: null, sentAt: null });
			results.push({ ...reminder, status: 'pending' });
			continue;
		}

		try {
			if (!reminder.userIds?.length || reminder.unresolvedRecipients?.length) throw new Error('提醒收件人未关联有效本站账号');
			const response = await messengerJson(messenger, '/notifications', {
                source: 'financing', category: 'financing',
                idempotencyKey: `reminder/${reminder.ruleId}/${reminder.targetId}/${reminder.periodId}`,
                userIds: reminder.userIds.filter(Boolean),
                title: `【融资工作台】${reminder.projectName} · ${reminder.taskName}`,
                text: `${reminder.ruleName}\n项目：${reminder.projectName}\n任务：${reminder.taskName}\n节点日期：${reminder.triggerDate}\n提醒周期：${reminder.periodLabel}`,
                url: `/financing/projects/${reminder.projectId}`
            });
			deliveries.push({
				...reminder, id: deliveryId, status: 'queued', providerMessageId: response.id,
				errorMessage: null, sentAt: null
			});
			results.push({ ...reminder, status: 'queued', messageId: response.id });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deliveries.push({
				...reminder, id: deliveryId, status: 'failed', providerMessageId: null,
				errorMessage: message, sentAt: null
			});
			results.push({ ...reminder, status: 'failed', error: message });
		}
	}
	if (deliveries.length) {
		await db.prepare(`
			INSERT INTO reminder_deliveries (
				id, rule_id, period_id, target_type, target_id, delivery_date, scheduled_for, recipients, status,
				provider_message_id, error_message, sent_at
			)
			SELECT id, rule_id, period_id, target_type, target_id, delivery_date, scheduled_for, recipients, status,
				provider_message_id, error_message, sent_at
			FROM jsonb_to_recordset(?::jsonb) AS source(
				id text, rule_id text, period_id text, target_type text, target_id text, delivery_date date,
				scheduled_for timestamptz,
				recipients jsonb, status text, provider_message_id text, error_message text, sent_at timestamptz
			)
			ON CONFLICT(rule_id, target_id, period_id) DO UPDATE SET
				delivery_date = EXCLUDED.delivery_date, scheduled_for = EXCLUDED.scheduled_for,
				recipients = EXCLUDED.recipients, status = EXCLUDED.status,
				provider_message_id = EXCLUDED.provider_message_id,
				error_message = EXCLUDED.error_message, sent_at = EXCLUDED.sent_at
		`).run(JSON.stringify(deliveries.map((delivery) => ({
			id: delivery.id,
			rule_id: delivery.ruleId,
			period_id: delivery.periodId,
			target_type: delivery.targetType,
			target_id: delivery.targetId,
			delivery_date: delivery.deliveryDate,
			scheduled_for: delivery.scheduledFor,
			recipients: delivery.recipients,
			status: delivery.status,
			provider_message_id: delivery.providerMessageId,
			error_message: delivery.errorMessage,
			sent_at: delivery.sentAt
		}))));
	}
	return { asOf: instant.toISOString(), asOfDate: isoDate(instant), dryRun: dryRun || !messenger, count: reminders.length, candidateCount, results };
}
