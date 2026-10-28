import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export async function creditDatabase(t, beforeDiff = false, beforeBond = false, beforeApplications = false, beforeEntries = false) {
  const db = new PGlite();
  const query = db.query.bind(db);
  db.query = async (...args) => { const r = await query(...args); return {...r,rowCount:r.rows.length || r.affectedRows || 0}; };
  t.after(() => db.close());
  for (const name of ['0001_financing_postgres.sql','0007_detach_projects_from_debt.sql','0015_income_certificate_dates_and_names.sql','0028_client_master.sql','0031_bank_client_identity.sql']) {
    await db.exec(fs.readFileSync(new URL(`../../financing-migrations/${name}`,import.meta.url),'utf8'));
  }
  await installBondInvestors(db);
  await db.exec(fs.readFileSync(new URL('../../financing-migrations/0036_debt_live_status.sql',import.meta.url),'utf8'));
  await db.exec('CREATE SCHEMA IF NOT EXISTS credit; CREATE TABLE credit.schema_migration(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of fs.readdirSync(new URL('../../credit-migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()) {
    if ((!beforeDiff || name < '0008') && (!beforeBond || name < '0009') && (!beforeApplications || name < '0013') && (!beforeEntries || name < '0018')) await applyCreditMigration(db,name);
  }
  return db;
}

export async function installBondInvestors(db) {
  await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA "authorization";
    CREATE FUNCTION "authorization".has_permission(code text) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.can_read',true)='on' AND code='financing.data:read' $$;
    GRANT USAGE ON SCHEMA financing,"authorization" TO authenticated;`);
  await db.exec(fs.readFileSync(new URL('../../financing-migrations/0034_bond_investors.sql',import.meta.url),'utf8'));
}

export async function seedCredit(db,date='2026-08-21',name='甲银行',patch={},eventType='maintenance') {
  await db.query("INSERT INTO public.client(name,type) VALUES ($1,'银行') ON CONFLICT(name) DO NOTHING",[name]);
  const legacy=(await db.query("SELECT to_regclass('credit.diff') AS relation")).rows[0].relation!==null;
  const fn=legacy?'append_diff':'append_entry';
  const sql=eventType==='maintenance'
    ? `SELECT credit.${fn}($1::date,$2,$3::jsonb,$4) AS id`
    : `SELECT credit.${fn}($1::date,$2,$3::jsonb,$4,$5) AS id`;
  return db.query(sql,[date,name,JSON.stringify({
    institution_type:'股份行',status:'approved',confidentiality_status:false,total:10,
    bond_investment_secondary_used:3,bond_investment_limit:4,effective_date:'2026-01-01',expiry_date:'2026-08-30',...patch,...(!legacy&&patch.status==='revoked'?{expiry_date:'1970-01-01'}:{})
  }),'auth0|test',...(eventType==='maintenance'?[]:[eventType])]);
}

export async function applyCreditMigration(db,name) {
  await db.exec('BEGIN');
  try {
    await db.exec(fs.readFileSync(new URL(`../../credit-migrations/${name}`,import.meta.url),'utf8'));
    await db.query('INSERT INTO credit.schema_migration(name) VALUES ($1)',[name]);
    await db.exec('COMMIT');
  } catch(error) { await db.exec('ROLLBACK');throw error; }
}

/** Finish historical migration fixtures before exercising the current API. */
export async function finishCreditMigrations(db,after) {
  const applied=new Set((await db.query('SELECT name FROM credit.schema_migration')).rows.map(row=>row.name));
  for(const name of fs.readdirSync(new URL('../../credit-migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()) {
    if(name>after && !applied.has(name))await applyCreditMigration(db,name);
  }
}
