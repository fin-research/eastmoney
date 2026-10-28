import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { importDebtWorkbook } from '../../src/lib/server/financing/debt-importer.js';
import { parseDebtWorkbookData } from './lib/excel-import.mjs';
import { transformWorkbook } from './lib/debt-transform.mjs';

const source = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
	?? path.resolve('data', 'ledger.xlsx');
const dryRun = process.argv.includes('--dry-run');
const rollback = process.argv.includes('--rollback');
const connectionString = process.env.DATABASE_URL;

const parsed = parseDebtWorkbookData(fs.readFileSync(source), path.basename(source));
const transformed = transformWorkbook(parsed);
if (dryRun) {
	console.log(JSON.stringify({
		mode: 'dry-run',
		source: path.basename(source),
		asOfDate: transformed.snapshot.asOfDate,
		totalYi: transformed.snapshot.totalYi,
		debtCount: transformed.debts.length,
		cashflowCount: transformed.cashflows.length,
		balanceCount: transformed.balances.length,
		debtTables: transformed.debts.reduce((counts, debt) => {
			counts[debt.table] = (counts[debt.table] ?? 0) + 1;
			return counts;
		}, {})
	}, null, 2));
	process.exit(0);
}
if (!connectionString) throw new Error('缺少 DATABASE_URL；本地维护脚本必须直连 Neon，不能通过 Worker 或 Hyperdrive 执行');

const client = new Client({
	connectionString,
	application_name: 'eastmoney-financing-local-maintenance'
});

await client.connect();
try {
	const result = await importDebtWorkbook(client, transformed, { rollback, refreshDerivatives: true });
	console.log(JSON.stringify({ ...result, source: path.basename(source) }, null, 2));
} finally {
	await client.end();
}
