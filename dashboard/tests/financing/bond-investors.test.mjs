import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyCreditMigration } from '../helpers/credit-database.mjs';
import { PGlite } from '@electric-sql/pglite';
import * as XLSX from 'xlsx';
import { importBondInvestors } from '../../scripts/financing/lib/bond-investor-import.mjs';
import { parseBondInvestorWorkbook } from '../../scripts/financing/lib/bond-investor-workbook.mjs';
import { loadBondInvestors } from '../../src/lib/server/financing/bond-investors.ts';
import { investorShare, validInvestorDate } from '../../src/lib/financing/bond-investors.ts';

async function database(t) {
  const db = new PGlite(); t.after(() => db.close());
  for (const name of ['0001_financing_postgres.sql', '0007_detach_projects_from_debt.sql', '0015_income_certificate_dates_and_names.sql', '0028_client_master.sql', '0031_bank_client_identity.sql']) await db.exec(fs.readFileSync(new URL(`../../financing-migrations/${name}`, import.meta.url), 'utf8'));
  await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA "authorization";
    CREATE FUNCTION "authorization".has_permission(code text) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.can_read',true)='on' AND code='financing.data:read' $$;
    GRANT USAGE ON SCHEMA financing,"authorization" TO authenticated;`);
  await db.exec(fs.readFileSync(new URL('../../financing-migrations/0034_bond_investors.sql', import.meta.url), 'utf8'));
  await db.exec('CREATE SCHEMA IF NOT EXISTS credit; CREATE TABLE credit.schema_migration(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of fs.readdirSync(new URL('../../credit-migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) await applyCreditMigration(db,name);
  return db;
}
async function bond(db, name = '债甲', amount = 300, dates = ['2026-01-01', '2027-01-01']) {
  return (await db.query(`INSERT INTO financing.bond(debt_type,subtype,name,amount,issue_date,maturity_date)
    VALUES ('债券','小公募',$1,$2,$3,$4) RETURNING id::text`, [name, amount, ...dates])).rows[0].id;
}
const row = (overrides = {}) => ({ bondName: '债甲', investorName: '甲基金', category: '公募基金', subtype: '小公募', channel: null, account: null, amount: 300, issueDate: '2026-01-01', maturityDate: '2027-01-01', ...overrides });

test('investor imports preserve split allocations, unknowns, rollback and repeat-run idempotence', async t => {
  const db = await database(t); await bond(db);
  const existingClients=(await db.query('SELECT * FROM public.client ORDER BY id')).rows;
  const parsed = { rows: [row({ amount: 40 }), row({ amount: 60 }), row({ investorName: '未知', category: '其他', amount: 200 })] };
  await db.exec('BEGIN');
  const preview = await importBondInvestors(db, parsed);
  assert.equal(preview.storedRows, 2); assert.equal(preview.sourceRows, 3);
  await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT * FROM financing.bond_investors')).rows.length, 0);
  assert.deepEqual((await db.query('SELECT * FROM public.client ORDER BY id')).rows, existingClients);
  await db.exec('BEGIN'); const first = await importBondInvestors(db, parsed); await db.exec('COMMIT');
  assert.equal(first.insertedRows, 2); assert.equal(first.unknownAmount, 200);
  assert.equal((await db.query('SELECT * FROM public.client WHERE name=\'未知\'')).rows.length, 0);
  await db.exec('BEGIN'); const repeat = await importBondInvestors(db, parsed); await db.exec('COMMIT');
  assert.equal(repeat.insertedRows, 0); assert.equal(repeat.createdClients.length, 0);
  await db.exec('BEGIN'); await assert.rejects(importBondInvestors(db, { rows: [row({ amount: 301 })] }), /发行本金不符/); await db.exec('ROLLBACK');
  await db.exec('BEGIN'); await assert.rejects(importBondInvestors(db, { rows: [row({ account: '改变账户' })] }), /拒绝覆盖/); await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT sum(amount)::text AS amount FROM financing.bond_investors')).rows[0].amount, '300.00');
});

test('investor table enforces actual bond/client foreign keys, nullable uniqueness, amounts and read-only RLS', async t => {
  const db = await database(t); const id = await bond(db);
  await db.query('INSERT INTO financing.bond_investors(bond_id,amount) VALUES ($1,10)', [id]);
  await assert.rejects(db.query('INSERT INTO financing.bond_investors(bond_id,amount) VALUES ($1,20)', [id]), /unique/);
  for (const amount of [0, -1, 'NaN']) await assert.rejects(db.query('INSERT INTO financing.bond_investors(bond_id,account,amount) VALUES ($1,\'另一账户\',$2)', [id, amount]), /check constraint/);
  await assert.rejects(db.query('INSERT INTO financing.bond_investors(bond_id,amount) VALUES (9999,10)'), /foreign key/);
  await assert.rejects(db.query('INSERT INTO financing.bond_investors(bond_id,investor_id,amount) VALUES ($1,9999,10)', [id]), /foreign key/);
  await db.exec('BEGIN; SET LOCAL ROLE authenticated');
  assert.equal((await db.query('SELECT * FROM financing.bond_investors')).rows.length, 0);
  await db.exec("SELECT set_config('test.can_read','on',true)");
  assert.equal((await db.query('SELECT * FROM financing.bond_investors')).rows.length, 1);
  await assert.rejects(db.query('DELETE FROM financing.bond_investors'), /permission denied/);
  await db.exec('ROLLBACK');
  await db.query('DELETE FROM financing.bond WHERE id=$1', [id]);
  assert.equal((await db.query('SELECT * FROM financing.bond_investors')).rows.length, 0);
});

test('report date excludes future issuance and maturity/settlement/closure day; uncaptured bonds remain visible as gaps', async t => {
  const db = await database(t);
  for (const [name, amount, dates, end] of [
    ['存续', 1e8, ['2026-01-01', '2027-01-01'], null],
    ['当日到期', 2e8, ['2026-01-01', '2026-09-10'], null],
    ['未来', 4e8, ['2026-09-11', '2027-01-01'], null],
    ['提前结清', 8e8, ['2026-01-01', '2027-01-01'], 'settled_at'],
    ['提前关闭', 16e8, ['2026-01-01', '2027-01-01'], 'closed_at']
  ]) {
    const id = await bond(db, name, amount, dates);
    if (end) await db.query(`UPDATE financing.bond SET ${end}='2026-09-10' WHERE id=$1`, [id]);
    await db.query('INSERT INTO financing.bond_investors(bond_id,amount) VALUES ($1,$2)', [id, amount]);
  }
  await bond(db, '缺明细', 32e8);
  const report = await loadBondInvestors(db, '2026-09-10');
  assert.equal(report.total.total, 27); assert.equal(report.outstanding.total, 1);
  assert.equal(report.coverage.missingBonds, 1); assert.equal(report.coverage.missingAmountYi, 32);
  assert.equal(report.investors[0].id, null); assert.equal(report.categories.find(row => row.category === '其他').total.total, 27);
  assert.equal((await loadBondInvestors(db, '2025-12-31')).total.total, 0);
  assert.equal(investorShare(0, 0), null); assert.equal(investorShare(0, 1), 0);
  assert.equal(validInvestorDate('2026-02-30'), false); assert.equal(validInvestorDate('2024-02-29'), true);
});

test('bank asset clients use the existing parent canonical name and preserve the bank identity', async t => {
  const db = await database(t); await bond(db);
  await db.exec("INSERT INTO public.client(name,type,subtype) VALUES ('广东顺德农商行','银行','农商行')");
  await db.exec('BEGIN');
  const result = await importBondInvestors(db, { rows: [row({ investorName: '顺德农商行资管', category: '银行理财' })] });
  await db.exec('COMMIT');
  assert.equal(result.createdClients[0].name, '广东顺德农商行资管');
  const client = (await db.query('SELECT name,type FROM public.client WHERE id=$1', [result.clientMapping['顺德农商行资管']])).rows[0];
  assert.deepEqual(client, { name: '广东顺德农商行资管', type: '理财子' });
});

test('workbook parser retains row coordinates, channel vs sales channel, and checks subtotal controls', () => {
  const book = XLSX.utils.book_new();
  for (const sheet of ['短融', '公募债', '公募次级债', '私募债']) {
    const short = sheet === '短融';
    const rows = [[], [null, '债券简称', '实际投资人'], [null, '债甲', '甲基金', '通道甲', '产品甲', ...(short ? ['公司销售'] : []), 100, null, 46023, 46388], [null, '合计', null, null, null, ...(short ? [null] : []), 100]];
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  }
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[null, null, '报表统计日', 46275], [], [], [], [null, '公募基金', '甲基金', 0.000004]]), '按投资机构');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[]]), '统计');
  const bytes = () => XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseBondInvestorWorkbook(bytes());
  assert.equal(parsed.rows.length, 4); assert.equal(parsed.rows[0].row, 3);
  assert.equal(parsed.rows[0].channel, '通道甲'); assert.equal(parsed.rows[0].account, '产品甲');
  book.Sheets['短融'].G4.v = 99;
  assert.throws(() => parseBondInvestorWorkbook(bytes()), /合计与明细不符/);
});
