/** @param {Env['DB']} db */
export async function readReminderCheckpoint(db) {
	return db.prepare('SELECT generation, checked_at, next_scan_at FROM financing_reminder_checkpoint WHERE id = 1').first();
}

/** Invalidate before and after a business write, including partially failed actions.
 * A concurrent scan may publish only against the generation it originally read.
 * @param {Env['DB']} db
 */
export async function invalidateReminderCheckpoint(db) {
	await db.prepare('UPDATE financing_reminder_checkpoint SET generation = generation + 1, next_scan_at = 0 WHERE id = 1').run();
}

/** @template T
 * @param {Env['DB']} db
 * @param {() => Promise<T> | T} operation
 */
export async function withReminderCheckpointInvalidation(db, operation) {
	await invalidateReminderCheckpoint(db);
	try { return await operation(); }
	finally { await invalidateReminderCheckpoint(db); }
}

/** All configured lead times are whole hours and due dates are Shanghai dates.
 * Cache only an empty SQL candidate set until the next hour. Do not cache users,
 * deliveries, errors, or candidates lacking an active recipient.
 * @param {Env['DB']} db
 * @param {number} generation
 * @param {number} scheduledTime
 */
export async function saveEmptyReminderCheckpoint(db, generation, scheduledTime) {
	const nextHour = (Math.floor(scheduledTime / 3_600_000) + 1) * 3_600_000;
	await db.prepare(`UPDATE financing_reminder_checkpoint SET checked_at = ?, next_scan_at = ?
		WHERE id = 1 AND generation = ? AND checked_at <= ?`)
		.bind(scheduledTime, nextHour, generation, scheduledTime).run();
}
