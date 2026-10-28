// @ts-nocheck

/**
 * Delete one project and every reminder delivery that points to the project or
 * one of its tasks. Project tasks are removed by the projects foreign key.
 */
export async function deleteProjectWithReminders(database, projectId, afterDelete) {
	if (!projectId) return null;
	return database.transaction(async (transaction) => {
		const selected = await transaction.query(`
			SELECT p.id, p.code, p.name, p.debt_type, p.status, p.owner_id,
				(SELECT COUNT(*) FROM financing.project_tasks task WHERE task.project_id = p.id) AS task_count
			FROM financing.projects p
			WHERE p.id = $1
			FOR UPDATE
		`, [projectId]);
		const row = selected.rows[0];
		if (!row) return null;

		const reminders = await transaction.query(`
			DELETE FROM financing.reminder_deliveries delivery
			WHERE (delivery.target_type = 'project' AND delivery.target_id = $1)
				OR (delivery.target_type = 'project_task' AND EXISTS (
					SELECT 1 FROM financing.project_tasks task
					WHERE task.id = delivery.target_id AND task.project_id = $1
				))
			RETURNING delivery.id
		`, [projectId]);
		const deleted = await transaction.query(
			'DELETE FROM financing.projects WHERE id = $1 RETURNING id',
			[projectId]
		);
		if (deleted.rows.length !== 1) throw new Error(`项目删除结果异常：${projectId}`);

		const before = {
			id: row.id,
			code: row.code,
			name: row.name,
			debtType: row.debt_type,
			status: row.status,
			ownerId: row.owner_id,
			taskCount: Number(row.task_count ?? 0),
			reminderCount: reminders.rows.length
		};
		if (afterDelete) await afterDelete({ transaction, before });
		return before;
	});
}
