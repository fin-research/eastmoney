/** Recompute the project start after an individual task's dates change.
 * @param {any} db @param {string} projectId
 */
export async function refreshProjectStart(db, projectId) {
	return db.prepare(`
		UPDATE projects p SET planned_start_date = LEAST(p.planned_issue_date, (
			SELECT MIN(CASE WHEN task.schedule_type = 'period' THEN task.planned_start_date ELSE task.due_date END)
			FROM project_tasks task WHERE task.project_id = p.id
		)), updated_at = CURRENT_TIMESTAMP
		WHERE p.id = ?
		RETURNING planned_start_date AS plannedStartDate, updated_at AS updatedAt
	`).get(projectId);
}
