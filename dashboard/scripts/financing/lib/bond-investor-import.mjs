import { investorCategory } from '../../../src/lib/financing/bond-investors.ts';
import { clientFromInvestor } from './bond-investor-workbook.mjs';

const key = row => JSON.stringify([String(row.bond_id), row.investor_id == null ? null : String(row.investor_id), row.channel, row.account]);
const cents = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(Math.round(number * 100))) throw new Error('金额超出安全范围');
  return Math.round(number * 100);
};

// The caller owns BEGIN/COMMIT. Abort on ambiguous identities or changed existing allocations.
export async function importBondInvestors(db, parsed, { clientCorrections = [] } = {}) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('financing.bond_investors.import'))");
  const names = [...new Set(parsed.rows.map(row => row.investorName))];
  const resolved = (await db.query(`SELECT n.name, c.id::text AS id, c.name AS client_name, c.type, c.subtype, p.name AS bank_name
    FROM unnest($1::text[]) n(name) LEFT JOIN public.client c ON c.id=public.resolve_client(n.name)
    LEFT JOIN public.client p ON n.name LIKE '%资管' AND p.id=public.resolve_client(regexp_replace(n.name,'资管$','')) AND p.type='银行'`, [names])).rows;
  const mapping = new Map();
  const createdClients = [], correctedClients = [];
  const missing = new Map();
  for (const item of resolved) {
    const category = parsed.rows.find(row => row.investorName === item.name).category;
    if (item.name === '未知') { mapping.set(item.name, null); continue; }
    const desired = clientFromInvestor(item.name, category);
    if (!item.id) {
      if (desired.subtype === '银行资管' && item.bank_name) desired.name = `${item.bank_name}资管`;
      missing.set(desired.name, desired);
      item.newName = desired.name;
    } else if (investorCategory(item.type, item.subtype) !== category) {
      const correction = clientCorrections.find(row => row.name === item.client_name && row.fromType === item.type && row.fromSubtype === item.subtype && row.toType === desired.type && row.toSubtype === desired.subtype);
      if (!correction) throw new Error(`${item.name} 客户分类与来源不符：${item.type}/${item.subtype} → ${category}；需明确的客户修订清单`);
      await db.query('UPDATE public.client SET type=$1,subtype=$2 WHERE id=$3', [desired.type, desired.subtype, item.id]);
      correctedClients.push(correction);
    }
    mapping.set(item.name, item.id);
  }
  if (missing.size) {
    const inserted = (await db.query(`INSERT INTO public.client(name,fullname,type,subtype)
      SELECT name,NULL,type,subtype FROM jsonb_to_recordset($1::jsonb) AS x(name text,type text,subtype text)
      RETURNING id::text,name`, [JSON.stringify([...missing.values()])])).rows;
    const verified = (await db.query('SELECT name,public.resolve_client(name)::text AS id FROM unnest($1::text[]) AS name', [resolved.filter(row => row.newName).map(row => row.name)])).rows;
    for (const item of resolved.filter(row => row.newName)) {
      const id = inserted.find(row => row.name === item.newName)?.id;
      if (!id || verified.find(row => row.name === item.name)?.id !== id) throw new Error(`${item.name} 客户归属不唯一`);
      mapping.set(item.name, id);
    }
    createdClients.push(...missing.values());
  }
  const bonds = (await db.query(`SELECT id::text,name,subtype,amount::text,issue_date::text,maturity_date::text
    FROM financing.bond WHERE name=ANY($1::text[]) FOR SHARE`, [[...new Set(parsed.rows.map(row => row.bondName))]])).rows;
  const byName = new Map();
  for (const bond of bonds) {
    if (byName.has(bond.name)) throw new Error(`债券简称匹配不唯一：${bond.name}`);
    byName.set(bond.name, bond);
  }
  const totals = new Map(), records = new Map(), dateDifferences = new Map();
  for (const row of parsed.rows) {
    const bond = byName.get(row.bondName);
    if (!bond || bond.subtype !== row.subtype) throw new Error(`债券缺失或品种不符：${row.bondName}`);
    if (bond.issue_date !== row.issueDate || bond.maturity_date !== row.maturityDate) dateDifferences.set(row.bondName, { bond: row.bondName, sourceIssueDate: row.issueDate, databaseIssueDate: bond.issue_date, sourceMaturityDate: row.maturityDate, databaseMaturityDate: bond.maturity_date });
    const record = { bond_id: bond.id, investor_id: mapping.get(row.investorName), channel: row.channel, account: row.account, amount: row.amount };
    const recordKey = key(record);
    const existing = records.get(recordKey);
    if (existing) existing.amount = (cents(existing.amount) + cents(record.amount)) / 100;
    else records.set(recordKey, record);
    totals.set(bond.id, (totals.get(bond.id) ?? 0) + cents(row.amount));
  }
  for (const bond of bonds) if (totals.get(bond.id) !== cents(bond.amount)) throw new Error(`${bond.name} 投资人合计与发行本金不符`);
  const existing = (await db.query('SELECT bond_id::text,investor_id::text,channel,account,amount::text FROM financing.bond_investors WHERE bond_id=ANY($1::bigint[])', [[...totals.keys()]])).rows;
  const existingBonds = new Set(existing.map(row => row.bond_id));
  const existingKeys = new Set(existing.map(key));
  for (const row of existing) if (!records.has(key(row)) || cents(records.get(key(row)).amount) !== cents(row.amount)) throw new Error('历史投资分配已发生变化，拒绝覆盖现有记录');
  for (const row of records.values()) if (existingBonds.has(row.bond_id) && !existingKeys.has(key(row))) throw new Error('债券已有不完整或不同的投资分配，拒绝自动补写');
  const added = [...records.values()].filter(row => !existingKeys.has(key(row)));
  if (added.length) await db.query(`INSERT INTO financing.bond_investors(bond_id,investor_id,channel,account,amount)
    SELECT bond_id,investor_id,channel,account,amount FROM jsonb_to_recordset($1::jsonb)
      AS x(bond_id bigint,investor_id bigint,channel text,account text,amount numeric)`, [JSON.stringify(added)]);
  return { sourceRows: parsed.rows.length, storedRows: records.size, insertedRows: added.length, bondCount: bonds.length,
    amount: [...totals.values()].reduce((a, b) => a + b, 0) / 100,
    unknownRows: parsed.rows.filter(row => row.investorName === '未知').length,
    unknownAmount: parsed.rows.filter(row => row.investorName === '未知').reduce((a, row) => a + row.amount, 0),
    createdClients, correctedClients, dateDifferences: [...dateDifferences.values()], clientMapping: Object.fromEntries(mapping) };
}

export function reconcileBondInvestorReport(report, parsed, mapping) {
  const checks = [];
  const check = (scope, label, actual, expected) => {
    const difference = typeof expected === 'number' && Number.isFinite(expected) ? actual - expected : null;
    checks.push({ scope, label, databaseYi: actual, workbookYi: expected, differenceYi: difference, matches: difference != null && Math.abs(difference) < 1e-8 });
  };
  const types = ['公募债', '公募次级债', '私募债', '短融', 'total'];
  for (const expected of parsed.structures) {
    const row = report.categories.find(item => item.category === expected.category);
    for (const metric of ['total', 'outstanding']) for (const [index, type] of types.entries()) check('分类汇总', `${expected.category}/${metric}/${type}`, row?.[metric][type] ?? 0, expected[metric][index]);
  }
  check('分类汇总', '累计合计', report.total.total, parsed.controls.total);
  check('分类汇总', '存续合计', report.outstanding.total, parsed.controls.outstanding);
  for (const expected of parsed.institutions) {
    const id = mapping[expected.name];
    const row = report.investors.find(item => item.id === id);
    check('按投资机构', `${expected.name}/累计`, row?.total.total ?? 0, expected.expectedTotal);
    check('按投资机构', `${expected.name}/存续`, row?.outstanding.total ?? 0, expected.expectedOutstanding);
  }
  check('统计页具体投资人', '公式表累计合计', report.total.total, parsed.controls.rankingTotal);
  check('统计页具体投资人', '公式表存续合计', report.outstanding.total, parsed.controls.rankingOutstanding);
  check('统计页静态副本', '静态表累计合计', report.total.total, parsed.controls.staticRankingTotal);
  check('统计页静态副本', '静态表存续合计', report.outstanding.total, parsed.controls.staticRankingOutstanding);
  const missingRanking = parsed.institutions.filter(row => row.expectedTotal > 0 && !parsed.ranking.some(item => item.name === row.name));
  return { checks, matches: checks.filter(row => row.matches).length, differences: checks.filter(row => !row.matches), missingRanking };
}
