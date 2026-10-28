import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {legacyPermissionSchema,migratePermissions} from './fixtures/unified-permission-schema.mjs';

test('debt delete cascades only its own cashflows while direct cashflow access remains denied',async()=>{
 const db=new PGlite();
 try {
  await legacyPermissionSchema(db);
  await migratePermissions(db);
  await db.exec(await readFile(new URL('../../financing-migrations/0037_debt_delete_cascade.sql',import.meta.url),'utf8'));
  const rows=(await db.query(`INSERT INTO financing.debt(debt_type,name,amount,issue_date,maturity_date) VALUES ('同业拆借','删除负债',100,'2026-10-01','2027-10-01'),('同业拆借','保留负债',200,'2026-10-01','2027-10-01') RETURNING id`)).rows;
  const [deleted,retained]=rows.map(row=>row.id);
  await db.query(`INSERT INTO financing.cashflow(debt_id,sequence,cashflow_type,due_date,amount) VALUES ($1,1,'principal','2027-10-01',100),($2,1,'principal','2027-10-01',200)`,[deleted,retained]);
  const assume=async permissions=>{
   await db.exec('BEGIN');
   await db.query("SELECT set_config('request.auth.user_id','auth0|person',true),set_config('request.auth.permissions',$1,true),set_config('request.auth.operation','DELETE',true)",[JSON.stringify(permissions)]);
   await db.exec('SET LOCAL ROLE authenticated');
  };
  for(const permissions of [['financing.data:read'],['financing.data:read','financing.data:create'],['financing.data:read','financing.data:update']]){
   await assume(permissions);assert.equal((await db.query('DELETE FROM financing.debt WHERE id=$1 RETURNING id',[deleted])).rows.length,0);await db.exec('ROLLBACK');
  }
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','financing.debt','TRIGGER') allowed")).rows[0].allowed,false);
  assert.equal((await db.query("SELECT has_function_privilege('authenticated','financing.cascade_debt_delete()','EXECUTE') allowed")).rows[0].allowed,false);
  await assume(['financing.data:read','financing.data:delete']);
  assert.equal((await db.query("DELETE FROM financing.debt WHERE id=$1 AND updated_at='2000-01-01' RETURNING id",[deleted])).rows.length,0);
  await db.exec('ROLLBACK');
  await assume(['financing.data:read','financing.data:delete']);
  await assert.rejects(db.query('DELETE FROM financing.cashflow WHERE debt_id=$1',[deleted]),{code:'42501'});await db.exec('ROLLBACK');
  await assume(['financing.data:read','financing.data:delete']);
  assert.equal((await db.query('DELETE FROM financing.debt WHERE id=$1 RETURNING id',[deleted])).rows.length,1);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int count FROM financing.cashflow')).rows[0].count,2);
  await assume(['financing.data:read','financing.data:delete']);
  assert.equal((await db.query('DELETE FROM financing.debt WHERE id=$1 RETURNING id',[deleted])).rows.length,1);await db.exec('COMMIT');
  assert.deepEqual((await db.query('SELECT debt_id FROM financing.cashflow')).rows.map(row=>row.debt_id),[retained]);
  assert.equal((await db.query('SELECT id FROM financing.debt')).rows.length,1);
 }finally{await db.close();}
});
