// @ts-nocheck
import { createPostgresDatabase } from '../../financing/postgres.js';
import { sendDueReminders } from './reminders.js';
import { readReminderCheckpoint, saveEmptyReminderCheckpoint } from './reminder-checkpoint.js';

function statusCounts(results) {
	return results.reduce((counts, result) => {
		const status = String(result.status ?? 'unknown');
		counts[status] = (counts[status] ?? 0) + 1;
		return counts;
	}, {});
}

/**
 * Execute one scheduled reminder scan with one request-scoped database connection.
 * Dependencies are injectable so the Worker boundary can be tested without external writes.
 */
export async function runScheduledReminderCheck({
	scheduledTime,
	env,
	createDatabase = createPostgresDatabase,
	send = sendDueReminders
}) {
	const asOf = new Date(scheduledTime);
	if (!Number.isFinite(asOf.getTime())) throw new Error('提醒调度时间无效');
	const checkpoint = env.DB ? await readReminderCheckpoint(env.DB) : null;
	if (checkpoint && checkpoint.checked_at <= scheduledTime && scheduledTime < checkpoint.next_scan_at) {
		return { event: 'reminders.cron.idle', asOf: asOf.toISOString(), count: 0, dryRun: false, statuses: {} };
	}

	const database = createDatabase(
		env.HYPERDRIVE.connectionString,
		'eastmoney-financing-reminders-cron'
	);
	try {
		const result = await send({ asOf, db: database, config: env });
		if (checkpoint && result.candidateCount === 0 && !result.dryRun) {
			await saveEmptyReminderCheckpoint(env.DB, checkpoint.generation, scheduledTime);
		}
		return {
			event: 'reminders.cron.completed',
			asOf: result.asOf,
			count: result.count,
			dryRun: result.dryRun,
			statuses: statusCounts(result.results)
		};
	} finally {
		await database.close();
	}
}
