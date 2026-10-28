import { createPostgresDatabase } from '../../src/lib/financing/postgres.js';
import { sendDueReminders } from '../../src/lib/server/financing/reminders.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('缺少 DATABASE_URL；提醒任务必须从本地直连 Neon');

const asOfArgument = process.argv.find((argument) => argument.startsWith('--at='));
const dateArgument = process.argv.find((argument) => argument.startsWith('--date='));
const asOf = asOfArgument?.slice('--at='.length)
	?? (dateArgument ? `${dateArgument.slice('--date='.length)}T23:59:59+08:00` : undefined);
const dryRun = process.argv.includes('--dry-run');
if (!dryRun) throw new Error('实际投递由 Worker Cron 经 messenger 执行；本地命令仅支持 --dry-run');
const db = createPostgresDatabase(connectionString, 'eastmoney-financing-reminders');

try {
	const result = await sendDueReminders({ asOf, dryRun, db, config: process.env });
	console.log(JSON.stringify(result, null, 2));
} finally {
	await db.close();
}
