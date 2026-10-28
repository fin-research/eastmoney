import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { parseBondInvestorWorkbook } from './lib/bond-investor-workbook.mjs';
import { importBondInvestors, reconcileBondInvestorReport } from './lib/bond-investor-import.mjs';
import { loadBondInvestors } from '../../src/lib/server/financing/bond-investors.ts';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--file') || !args.includes('--report')) throw new Error('用法：node scripts/financing/import-bond-investors.mjs --file <xlsx> --report <json> [--client-corrections <json>] [--apply]');
const bytes = fs.readFileSync(option('--file'));
const parsed = parseBondInvestorWorkbook(bytes);
const clientCorrections = args.includes('--client-corrections') ? JSON.parse(fs.readFileSync(option('--client-corrections'), 'utf8')) : [];
const db = new Client({ connectionString: process.env.DATABASE_URL || process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, application_name: 'bond-investors-import' });
await db.connect();
try {
  await db.query('BEGIN');
  const imported = await importBondInvestors(db, parsed, { clientCorrections });
  const report = await loadBondInvestors(db, parsed.reportDate);
  const reconciliation = reconcileBondInvestorReport(report, parsed, imported.clientMapping);
  // Summary/ranking defects are reported; detail/principal and classification controls must reconcile.
  if (reconciliation.differences.some(row => ['分类汇总', '按投资机构'].includes(row.scope))) throw new Error(`明细统计不一致：${JSON.stringify(reconciliation.differences.filter(row => ['分类汇总', '按投资机构'].includes(row.scope)))}`);
  await db.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
  const result = { mode: args.includes('--apply') ? 'applied' : 'rollback-preview', sourceSha256: createHash('sha256').update(bytes).digest('hex'), reportDate: parsed.reportDate, ...imported, reconciliation, report };
  fs.writeFileSync(option('--report'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ mode: result.mode, reportDate: parsed.reportDate, sourceRows: imported.sourceRows, storedRows: imported.storedRows, insertedRows: imported.insertedRows, bondCount: imported.bondCount, createdClients: imported.createdClients.length, correctedClients: imported.correctedClients, totalYi: report.total.total, outstandingYi: report.outstanding.total, matches: reconciliation.matches, differences: reconciliation.differences, reportFile: option('--report') }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  throw error;
} finally { await db.end(); }
