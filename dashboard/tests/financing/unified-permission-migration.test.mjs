import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {legacyPermissionSchema,migratePermissions} from './fixtures/unified-permission-schema.mjs';
import {PERMISSION_CODES} from '../../src/lib/permissions.ts';
import {roleConfiguration,saveRoleConfiguration,rolePermissions} from './fixtures/permission-repository.ts';

test('permission migration preserves business references, refuses unmapped identities and removes local identity/audit storage atomically',async()=>{
 const db=new PGlite();
 try {
  await legacyPermissionSchema(db);
  await db.exec(`INSERT INTO financing.debt_limit_configs(debt_type,limit_yi) VALUES ('fixture',100);
    INSERT INTO financing.sop_templates(id,name,debt_type) VALUES ('permission-sop','权限模板','公司债');
    INSERT INTO financing.sop_nodes(id,template_id,name,sort_order,default_owner_role) VALUES ('permission-node','permission-sop','默认经办',1,'handler');
    INSERT INTO financing.people(id,name,email,role,active,auth0_user_id) VALUES ('legacy-person','测试人员','person@18.cn','admin',true,'auth0|removed');
    INSERT INTO financing.projects(id,code,name,debt_type,owner_id) VALUES ('permission-project','PERM','权限迁移测试','公司债','legacy-person');
    INSERT INTO financing.project_tasks(id,project_id,name,assignee_id) VALUES ('permission-task','permission-project','任务','legacy-person');
    INSERT INTO financing.liability_weekly_report_runs(id,as_of_date,generated_by_person_id,r2_key,content_sha256,status) VALUES ('permission-report','2026-09-01','legacy-person','fixture',repeat('a',64),'complete');`);
  await assert.rejects(migratePermissions(db),/Unverified Auth0 identity/);
  assert.equal((await db.query("SELECT owner_id FROM financing.projects WHERE id='permission-project'")).rows[0].owner_id,'legacy-person');
  assert.equal((await db.query("SELECT to_regclass('\"authorization\".permission') AS value")).rows[0].value,null);
  await migratePermissions(db,{mapping:{'legacy-person':'auth0|person'}});
  assert.equal((await db.query("SELECT owner_id FROM financing.projects WHERE id='permission-project'")).rows[0].owner_id,'auth0|person');
  assert.equal((await db.query("SELECT assignee_id FROM financing.project_tasks WHERE id='permission-task'")).rows[0].assignee_id,'auth0|person');
  assert.equal((await db.query("SELECT generated_by FROM financing.liability_weekly_report_runs WHERE id='permission-report'")).rows[0].generated_by,'auth0|person');
  assert.equal((await db.query("SELECT default_owner_role FROM financing.sop_nodes WHERE id='permission-node'")).rows[0].default_owner_role,'rol_Handler');
  for(const table of ['people','role_permissions','audit_logs'])assert.equal((await db.query(`SELECT to_regclass('financing.${table}') AS value`)).rows[0].value,null);
  const codes=(await db.query('SELECT code FROM "authorization".permission ORDER BY sort_order')).rows.map(row=>row.code);
  // Archived SQL predates the Auth0-only workflow, interbank and messenger permissions. Preserve its 58-code snapshot.
  assert.equal(codes.length,58);
  const retiredAssistantCodes = new Set(['credit.assistant:read', 'credit.assistant:ask', 'credit.assistant:delete', 'credit.material:upload', 'credit.material:delete']);
  assert.ok([...retiredAssistantCodes].every(code=>codes.includes(code)), 'historical migration retains its original permissions');
  assert.deepEqual(codes.filter(code=>!retiredAssistantCodes.has(code)),
    PERMISSION_CODES.filter(code=>code!=='research.workflow:update'&&!code.startsWith('research.interbank:')&&!code.startsWith('messenger.')));
  assert.ok(!codes.includes('research.workflow:update'));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "authorization".role_permission')).rows[0].count,3*codes.length);
  const report=(await db.query("SELECT financing.liability_weekly_report_data('2026-09-01') AS value")).rows[0].value;
  assert.equal(report.report.projects.find(project=>project.id==='permission-project').ownerId,'auth0|person');
  // Saving an empty role is persisted, does not affect other roles, and detects a stale editor.
  const before=await roleConfiguration(db,'rol_Handler');
  await db.exec('BEGIN');const saved=await saveRoleConfiguration(db,'rol_Handler',[],before.version,'auth0|person');await db.exec('COMMIT');
  assert.deepEqual(saved.permissions,[]);assert.notEqual(saved.version,before.version);
  await db.exec('BEGIN');await assert.rejects(saveRoleConfiguration(db,'rol_Handler',['financing.project:read'],before.version,'auth0|person'),{status:409});await db.exec('ROLLBACK');
  assert.ok((await rolePermissions(db,['rol_Admin','rol_Handler'])).includes('financing.project:read'));
  assert.deepEqual(await rolePermissions(db,['rol_Unknown']),[]);
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','\"authorization\".role_permission','UPDATE') AS allowed")).rows[0].allowed,false);
  await db.exec("BEGIN; SET LOCAL ROLE authenticated");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM financing.debt_limit_configs")).rows[0].count,0);
  await db.exec('ROLLBACK');
  await db.exec('BEGIN');
  await db.query("SELECT set_config('request.auth.user_id',$1,true),set_config('request.auth.permissions',$2,true),set_config('request.auth.operation','GET',true)",['auth0|person',JSON.stringify(['financing.data:read'])]);
  await db.exec('SET LOCAL ROLE authenticated');
  const visible=(await db.query('SELECT count(*)::int AS count FROM financing.debt_limit_configs')).rows[0].count;assert.ok(visible>0);
  assert.equal((await db.query("UPDATE financing.debt_limit_configs SET limit_yi=limit_yi RETURNING debt_type")).rows.length,0);
  await db.exec('ROLLBACK');
  await db.exec('BEGIN');
  await db.query("SELECT set_config('request.auth.user_id',$1,true),set_config('request.auth.permissions',$2,true),set_config('request.auth.operation','PATCH',true)",['auth0|person',JSON.stringify(['financing.data:update'])]);
  await db.exec('SET LOCAL ROLE authenticated');
  assert.equal((await db.query("UPDATE financing.debt_limit_configs SET limit_yi=limit_yi RETURNING debt_type")).rows.length,visible);
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT \"authorization\".has_permission('financing.data:update') AS allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});
