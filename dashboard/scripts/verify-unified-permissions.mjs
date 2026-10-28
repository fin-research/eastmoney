import assert from 'node:assert/strict';
import { Client } from 'pg';
import { PERMISSION_CODES } from '../src/lib/permissions.ts';

const db = new Client({connectionString:process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,application_name:'eastmoney-permission-verification'});
await db.connect();
try {
  const actual = (await db.query('SELECT code FROM "authorization".permission ORDER BY sort_order')).rows.map(row=>row.code);
  assert.deepEqual(actual,PERMISSION_CODES);
  const old = (await db.query("SELECT to_regclass('financing.people') AS people,to_regclass('financing.role_permissions') AS permissions,to_regclass('financing.audit_logs') AS audit")).rows[0];
  assert.deepEqual(old,{people:null,permissions:null,audit:null});
  const references = (await db.query(`SELECT
    (SELECT count(*)::int FROM financing.projects WHERE owner_id IS NOT NULL) AS project_owners,
    (SELECT count(*)::int FROM financing.project_tasks WHERE assignee_id IS NOT NULL) AS task_assignees,
    (SELECT count(*)::int FROM financing.liability_weekly_report_runs WHERE generated_by IS NOT NULL) AS report_authors,
    (SELECT count(*)::int FROM financing.sop_nodes WHERE default_owner_role IS NOT NULL) AS sop_roles`)).rows[0];
  for(const [table,column,pattern] of [['projects','owner_id','^auth0[|]'],['project_tasks','assignee_id','^auth0[|]'],['liability_weekly_report_runs','generated_by','^auth0[|]'],['sop_nodes','default_owner_role','^rol_']]) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM financing.${table} WHERE ${column} IS NOT NULL AND ${column} !~ $1`,[pattern])).rows[0].count,0);
  }
  const roles = (await db.query('SELECT auth0_role_id, count(*)::int AS permissions, count(*) FILTER (WHERE granted)::int AS granted FROM "authorization".role_permission GROUP BY auth0_role_id ORDER BY auth0_role_id')).rows;
  const table='financing.financial_monthly_data';
  const before = (await db.query(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY period_end LIMIT 1`)).rows[0]?.value;
  assert.ok(before,'Need one financial-month row to verify RLS');
  const total = Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  await db.query('BEGIN');
  await db.query('SET LOCAL ROLE authenticated');
  assert.equal(Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count),0);
  await db.query('ROLLBACK');
  async function context(permissions,method) {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.auth.user_id','auth0|permission-verification',true),set_config('request.auth.permissions',$1,true),set_config('request.auth.operation',$2,true)",[JSON.stringify(permissions),method]);
    await db.query('SET LOCAL ROLE authenticated');
  }
  await context(['financing.data:read'],'GET');
  assert.equal(Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count),total);
  assert.equal((await db.query(`UPDATE ${table} SET notes=notes WHERE period_end=$1 RETURNING period_end`,[before.period_end])).rowCount,0);
  await db.query('ROLLBACK');
  await context(['financing.data:update'],'PATCH');
  assert.equal((await db.query(`UPDATE ${table} SET notes=notes WHERE period_end=$1 RETURNING period_end`,[before.period_end])).rowCount,1);
  await db.query('ROLLBACK');
  assert.deepEqual((await db.query(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY period_end LIMIT 1`)).rows[0].value,before);
  assert.equal((await db.query(`SELECT "authorization".has_permission('financing.data:update') AS allowed`)).rows[0].allowed,false);
  const privileges = (await db.query(`SELECT has_table_privilege('authenticated','"authorization".role_permission','UPDATE') AS can_update`)).rows[0];
  assert.equal(privileges.can_update,false);
  console.log(JSON.stringify({permissionCount:actual.length,roles,references,rls:{anonymousRows:0,readRows:total,readOnlyWriteDenied:true,authorizedWriteRolledBack:true,transactionContextCleared:true},legacyTablesRemoved:true}));
} finally { await db.query('ROLLBACK').catch(()=>undefined);await db.end(); }
