import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCreditReport } from '../src/lib/server/credit-repository.ts';
import { compareCreditInstitutionOrder } from '../src/lib/credit/presentation.ts';

const base = { id: 1, institution_name: '甲银行', effective_on: '2026-08-01', created_at: '2026-08-01T00:00:00Z',
  created_by: null, updated_at: null, type: 'maintenance', confidentiality_status:false, status: 'approved', institution_type: '城商行',
  effective_date: '2026-08-01', expiry_date: '2026-08-31', total: 10, bond_investment_secondary_used: 2 };
import {creditDatabase} from './helpers/credit-database.mjs';

test('lazy snapshots retain historical renewal periods and independent amount/calendar states', async t => {
  const db=await creditDatabase(t);
  await db.query("INSERT INTO public.client(name,type) VALUES ('甲银行','银行')");
  const rows = [base,
    { id: 2, institution_name: '甲银行', effective_on: '2026-08-20', created_at: '2026-08-20T00:00:00Z', created_by: null,
      updated_at: null, type: 'renewal', effective_date: '2026-09-01', expiry_date: '2026-09-30', total: 12 },
    { id: 3, institution_name: '甲银行', effective_on: '2026-08-25', created_at: '2026-08-25T00:00:00Z', created_by: null,
      updated_at: null, type: 'maintenance', bond_investment_secondary_used: 4 },
    { id: 4, institution_name: '甲银行', effective_on: '2026-09-10', created_at: '2026-09-10T00:00:00Z', created_by: null,
      updated_at: null, type: 'renewal', effective_date: '2026-10-01', expiry_date: '2030-01-31' }];
  for (const row of rows) {
    const {id,institution_name,effective_on,created_at,created_by,updated_at,type,...patch}=row;
    await db.query('SELECT credit.append_entry($1::date,$2,$3::jsonb,$4,$5)',[effective_on,institution_name,JSON.stringify(patch),created_by,type]);
  }
  const august = await loadCreditReport(db, '2026-08-26');
  assert.equal(august.institutions[0].totalLimit, 12);
  assert.equal(august.institutions[0].totalUsed, 4);
  assert.equal(august.institutions[0].status,'approved');
  assert.equal(august.previousSummary.totalLimit, 10);
  assert.equal(august.previousSummary.totalUsed, 2);
  assert.ok(august.calendarEvents.some(e => e.date === '2026-08-25' && e.usageComponent === 'secondary' && /增加2亿元/.test(e.label)));
  const september = await loadCreditReport(db, '2026-09-15');
  assert.equal(september.institutions[0].status,'approved');
  const futureCalendar = await loadCreditReport(db, '2026-09-15', '2030-01');
  assert.ok(futureCalendar.calendarEvents.some(e => e.kind === 'expiry' && e.date === '2030-01-31'));
  assert.equal(september.calendarEvents.some(e => e.date === '2030-01-31'), false);
});

test('reused Chinese collators preserve legacy type and numeric name ordering', () => {
  const rows = ['甲银行10', '甲银行2', '乙银行', 'A银行', '甲银行01'].flatMap(institutionName =>
    ['城商行', '股份行', '国有行', '国有银行', '其它', '其他'].map(institutionType => ({ institutionName, institutionType })));
  const order = { '国有行': 1, '国有银行': 1, '股份行': 2, '城商行': 3 };
  const legacy = (a,b) => (order[a.institutionType] ?? 7) - (order[b.institutionType] ?? 7)
    || a.institutionType.localeCompare(b.institutionType, 'zh-CN')
    || a.institutionName.localeCompare(b.institutionName, 'zh-CN', { numeric: true });
  assert.deepEqual([...rows].sort(compareCreditInstitutionOrder), [...rows].sort(legacy));
});
