// Exercise the production SvelteKit build with signed fixture identities,
// local PostgreSQL (PGlite), and mocked Auth0/R2. Never contact production data.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { PERMISSION_CODES } from '../src/lib/permissions.ts';
import { roleConfiguration } from '../tests/financing/fixtures/permission-repository.ts';
import { legacyPermissionSchema, migratePermissions } from '../tests/financing/fixtures/unified-permission-schema.mjs';
import { financingTimestamp } from '../src/lib/financing/time.js';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';

const gateway = resolve(process.env.GATEWAY_CHECKOUT || '../gateway');
const { gatewayRequest } = await import(pathToFileURL(resolve(gateway, 'src/app.ts')));
const { identityService } = await import(pathToFileURL(resolve(gateway, 'src/identity-service.ts')));
const { Client: GatewayClient } = createRequire(resolve(gateway, 'package.json'))('pg');
const { vars } = JSON.parse(await readFile(resolve(gateway, 'wrangler.jsonc'), 'utf8'));
const gatewayOriginals = { connect: GatewayClient.prototype.connect, query: GatewayClient.prototype.query, end: GatewayClient.prototype.end };
const roleIds = { admin:'rol_Admin', handler:'rol_Handler', reviewer:'rol_Reviewer' };
const roles = Object.entries(roleIds).map(([name,id]) => ({id,name:'financing:'+name}));
const db = new PGlite({ parsers: { 1082: value => value, 1114: financingTimestamp, 1184: financingTimestamp } });
await legacyPermissionSchema(db);
await migratePermissions(db, {users:[],roles});
await db.exec(await readFile(new URL('../financing-migrations/0033_sop_schedule_periods.sql', import.meta.url), 'utf8'));
await db.query("INSERT INTO financing.financial_monthly_data(period_end,net_capital) VALUES ('2026-08-31',100)");
const account = { user_id: 'auth0|route-admin', email: 'route-admin@18.cn', name: '权限回归人员', email_verified: true, identities: [{ connection: 'eastmoney-email' }] };
const roleless = { ...account, user_id:'auth0|unlinked', email:'unlinked@18.cn', name:'未分配角色人员' };
const other = { ...account, user_id:'auth0|other-person', email:'other@18.cn', name:'其他经办' };
let opened = 0, closed = 0, queries = 0, active = 0, peak = 0;
const databaseSubjects = [];
const originals = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end, fetch: globalThis.fetch };
Client.prototype.connect = async function () { opened++; active++; peak = Math.max(peak, active); };
Client.prototype.end = async function () { closed++; active--; };
Client.prototype.query = async function (sql, params = []) {
  queries++;
  if (sql.includes("set_config('request.auth.user_id'")) databaseSubjects.push(params[0]);
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
Object.assign(GatewayClient.prototype, { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end });
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'financing-route-key', alg: 'RS256', use: 'sig' };
const origin = 'https://eastmoney.hasbai.xyz';
async function tokenFor(subject, email) {
  return new SignJWT({ azp: vars.AUTH0_CLIENT_ID, 'https://eastmoney.hasbai.xyz/email': email })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject(subject)
    .setIssuer(`https://${vars.AUTH0_LOGIN_DOMAIN}/`).setAudience(vars.AUTH0_AUDIENCE)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
}
const adminToken = await tokenFor(account.user_id, account.email);
const unlinkedToken = await tokenFor('auth0|unlinked', 'unlinked@18.cn');
let currentPermissions = [...PERMISSION_CODES];
let auth0Requests = 0;
const permissionObjects = () => currentPermissions.map(permission_name => ({ permission_name, resource_server_identifier: 'https://eastmoney.hasbai.xyz/financing' }));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === `https://${vars.AUTH0_LOGIN_DOMAIN}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
  assert.equal(url.origin, `https://${vars.AUTH0_DOMAIN}`, 'Unexpected external network request');
  auth0Requests++;
  if (url.pathname === '/oauth/token') {
    const credentials = input instanceof Request ? await input.clone().json() : JSON.parse(init.body);
    assert.equal(credentials.client_id, vars.AUTH0_MANAGEMENT_CLIENT_ID);
    assert.equal(credentials.client_secret, 'fixture-profile-secret');
    return Response.json({ access_token: 'fixture-management-token', expires_in: 60 });
  }
  if (/\/permissions$/.test(url.pathname)) return Response.json(permissionObjects());
  if (url.pathname === '/api/v2/roles') return Response.json(roles);
  if (/\/roles$/.test(url.pathname)) return Response.json(url.pathname.includes('unlinked') ? [] : [roles[0]]);
  if (/\/roles\/[^/]+\/users$/.test(url.pathname)) return Response.json(url.pathname.includes(roleIds.admin) ? [account] : []);
  if (url.pathname === '/api/v2/users') return Response.json([account,roleless,other]);
  if (url.pathname.endsWith('auth0%7Cunlinked')) return Response.json(roleless);
  if (url.pathname.endsWith('auth0%7Cother-person')) return Response.json(other);
  assert.equal(url.pathname, '/api/v2/users/auth0%7Croute-admin');
  assert.equal(init.method ?? 'GET', 'GET', 'Route read unexpectedly changed an Auth0 account');
  return Response.json(account);
};
const env = { ...vars, AUTHORIZATION_DB: { connectionString: 'postgres://test:test@localhost/fixture' }, HYPERDRIVE: { connectionString: 'postgres://test:test@localhost/fixture' },
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'fixture-profile-secret',
  LIABILITY_REPORT_SNAPSHOTS: { async get() { return null; } },
  EASTMONEY: { async list() { return { objects: [], truncated: false }; } },
};
env.IDENTITY = { fetch: request => identityService(request, env) };
const server = new Server(manifest);
await server.init({ env });
env.DASHBOARD = { fetch(request) {
  const context = JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context'), 'base64url').toString());
  const headers = new Headers(request.headers); headers.delete('X-Eastmoney-Gateway-Context');
  return server.respond(new Request(request, { headers }), { getClientAddress: () => '127.0.0.1', platform: { env: { ...env, GATEWAY_CONTEXT: context }, context: { waitUntil() {} } } });
} };
async function respond(path, { token = adminToken, method = 'GET', headers = {}, body } = {}) {
  const before = opened;
  const response = await gatewayRequest(new Request(origin + path, { method, headers: {
    Accept: 'text/html', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
  }, body }), env);
  assert.equal(active, 0, `${path}: database client was not closed`);
  assert.ok(opened - before <= 2, `${path}: unexpected extra database connection`);
  return response;
}
let checks = 0;
try {
  for (const path of ['/financing', '/financing/projects', '/financing/sop', '/financing/liability-report', '/management/people']) {
    const response = await respond(path, { token: null });
    assert.equal(response.status, 303, path);
    assert.match(response.headers.get('location'), /^\/auth\/login\?/); checks++;
  }
  for (const path of ['/', '/profile', '/management']) {
    const before = queries;
    assert.equal((await respond(path, { token: unlinkedToken })).status, 200, path);
    assert.equal(queries, before, `${path}: unexpected financing query`); checks++;
  }
  const session = await respond('/auth/session', { headers: { Accept: 'application/json' } });
  assert.deepEqual((await session.json()).user, { id: account.user_id, email: account.email, auth0Id: account.user_id }); checks++;
  assert.equal((await respond('/financing', { token: unlinkedToken })).status, 200); checks++;
  assert.equal((await respond('/financing/avatar?v=fixture')).status,410); checks++;
  for (const [path,target,status] of [['/financing/people','/management/people',307],['/financing/settings','/profile',303],['/management/financing-profile','/profile',303]]) {
    const response=await respond(path);assert.equal(response.status,status);assert.equal(response.headers.get('location'),target);checks++;
  }
  for (const path of ['/financing', '/financing/projects', '/financing/sop', '/financing/data', '/financing/liability-report', '/financing/sop/reminders', '/management/people']) {
    const response = await respond(path);
    const body = await response.text();
    assert.equal(response.status, 200, `${path}: ${body.slice(0, 300)}`);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((body.match(/class="global-message-region\b/g) ?? []).length, 1, path);
    assert.equal((body.match(/id="tr-workbench-main"/g) ?? []).length, 1, path);
    assert.doesNotMatch(body, /fixture-financing-secret|fixture-management-token|postgres:\/\//);
    checks++;
  }
  env.AUTHORIZATION_MODE = 'enforce';
  currentPermissions = [];
  await db.query('UPDATE "authorization".role_permission SET granted = false');
  for (const path of ['/financing/projects?/createProject', '/management/people?/saveRolePermissions', '/financing/data/import']) {
    const response = await respond(path, { method: 'POST', headers: { Accept: 'application/json' } });
    assert.equal(response.status, 403, path); checks++;
  }
  currentPermissions = [...PERMISSION_CODES];
  await db.query('UPDATE "authorization".role_permission SET granted = true');
  const initialRole = await roleConfiguration(db,roleIds.handler);
  const permissionForm = new URLSearchParams({roleId:roleIds.handler,version:initialRole.version});
  permissionForm.append('permissions','financing.project:read');
  const configured = await respond('/management/people?/saveRolePermissions',{method:'POST',headers:{Accept:'application/json','X-SvelteKit-Action':'true'},body:permissionForm});
  assert.equal((await configured.json()).type,'success');
  assert.deepEqual((await roleConfiguration(db,roleIds.handler)).permissions,['financing.project:read']); checks++;
  const stale = await respond('/management/people?/saveRolePermissions',{method:'POST',headers:{Accept:'application/json','X-SvelteKit-Action':'true'},body:permissionForm});
  const staleResult = await stale.json();assert.equal(staleResult.type,'failure');assert.equal(staleResult.status,409);checks++;
  const dataRead = await respond('/financing/data/api/financial_monthly_data', { headers: { Accept: 'application/json' } });
  assert.equal(dataRead.status, 200, await dataRead.clone().text());
  assert.equal((await dataRead.json()).length,1,'Authorized data read must actually return the seeded row');
  assert.deepEqual(databaseSubjects, [account.user_id]);
  assert.notEqual((await db.query('SELECT current_user AS role')).rows[0].role, 'authenticated');
  assert.equal((await db.query("SELECT nullif(current_setting('request.auth.user_id',true), '') AS subject")).rows[0].subject, null); checks++;
  const sop = (await db.query('SELECT id FROM financing.sop_templates WHERE is_active ORDER BY id LIMIT 1')).rows[0];
  assert.ok(sop);
  async function action(path, fields, expectedStatus) {
    const response = await respond(path, {
      method: 'POST', headers: { Accept: 'application/json', 'X-SvelteKit-Action': 'true' },
      body: new URLSearchParams(fields),
    });
    const result = await response.json();
    assert.equal(result.type, expectedStatus ? 'failure' : 'success', JSON.stringify(result));
    if (expectedStatus) assert.equal(result.status, expectedStatus, JSON.stringify(result));
    checks++;
    return result;
  }
  const sopPath = `/financing/sop/${sop.id}`;
  await action(`${sopPath}?/addNode`, {name:'时段回归节点',scheduleType:'period',startOffsetDays:'-10',offsetDays:'2'});
  const periodNode = (await db.query("SELECT id FROM financing.sop_nodes WHERE name='时段回归节点'")).rows[0];
  assert.ok(periodNode);
  await action(`${sopPath}?/updateNode`, {nodeId:periodNode.id,name:'时段回归节点',scheduleType:'period',startOffsetDays:'3',offsetDays:'2'},400);
  assert.equal((await db.query('SELECT default_start_offset_days FROM financing.sop_nodes WHERE id=$1',[periodNode.id])).rows[0].default_start_offset_days,-10);
  assert.match(await (await respond(sopPath)).text(), /启动时点/);
  const creation = await respond('/financing/projects?/createProject', {
    method: 'POST', headers: { Accept: 'application/json', 'X-SvelteKit-Action': 'true' },
    body: new URLSearchParams({ name: '路由回归项目', sopTemplateId: sop.id, amountYi: '1.5', plannedBookbuildingDate: '2026-10-09' }),
  });
  assert.equal(creation.status, 200, await creation.clone().text());
  assert.equal((await creation.json()).type, 'success');
  const project = (await db.query("SELECT id, planned_issue_date FROM financing.projects WHERE name = '路由回归项目'")).rows[0];
  assert.equal(project?.planned_issue_date, '2026-10-09');
  assert.equal((await respond(`/financing/projects/${project.id}`)).status, 200); checks += 2;
  const taskPath = `/financing/projects/${project.id}`;
  let periodTask = (await db.query('SELECT * FROM financing.project_tasks WHERE project_id=$1 AND sop_node_id=$2',[project.id,periodNode.id])).rows[0];
  assert.deepEqual([periodTask.schedule_type,periodTask.planned_start_date,periodTask.due_date],['period','2026-09-29','2026-10-11']);
  assert.ok((await db.query("SELECT count(*)::int AS n FROM financing.project_tasks WHERE project_id=$1 AND schedule_type='point' AND planned_start_date IS NULL",[project.id])).rows[0].n>0);
  await action(`${taskPath}?/updateTask`,{taskId:periodTask.id,status:'in_progress',scheduleType:'period',plannedStartDate:'2026-09-08',dueDate:'2026-10-12'});
  assert.equal((await db.query('SELECT planned_start_date FROM financing.projects WHERE id=$1',[project.id])).rows[0].planned_start_date,'2026-09-08');
  await action(`${taskPath}?/updateTask`,{taskId:periodTask.id,status:'completed',scheduleType:'period',plannedStartDate:'2026-10-13',dueDate:'2026-10-12'},400);
  assert.equal((await db.query('SELECT status FROM financing.project_tasks WHERE id=$1',[periodTask.id])).rows[0].status,'in_progress');
  await action(`${taskPath}?/addTask`,{name:'独立时段',scheduleType:'period',plannedStartDate:'2026-09-20',dueDate:'2026-10-30'});
  await action('/financing/projects?/updateProject',{id:project.id,name:'路由回归项目',status:'planning',plannedBookbuildingDate:'2026-10-16'});
  periodTask=(await db.query('SELECT * FROM financing.project_tasks WHERE id=$1',[periodTask.id])).rows[0];
  assert.deepEqual([periodTask.planned_start_date,periodTask.due_date],['2026-09-15','2026-10-19']);
  assert.equal((await db.query("SELECT due_date FROM financing.project_tasks WHERE project_id=$1 AND name='独立时段'",[project.id])).rows[0].due_date,'2026-10-30');
  assert.match(await (await respond(taskPath)).text(), /2026-09-15/);
  await action(`${taskPath}?/updateTask`,{taskId:periodTask.id,status:'in_progress',scheduleType:'point',dueDate:'2026-10-19'});
  assert.deepEqual((await db.query('SELECT schedule_type,planned_start_date FROM financing.project_tasks WHERE id=$1',[periodTask.id])).rows[0],{schedule_type:'point',planned_start_date:null});
  await action(`${sopPath}?/updateNode`, {nodeId:periodNode.id,name:'时段回归节点',scheduleType:'point',offsetDays:'2'});
  assert.equal((await db.query('SELECT default_start_offset_days FROM financing.sop_nodes WHERE id=$1',[periodNode.id])).rows[0].default_start_offset_days,null);
  const task = (await db.query('SELECT id FROM financing.project_tasks WHERE project_id=$1 ORDER BY id LIMIT 1', [project.id])).rows[0];
  assert.ok(task);
  await db.query('UPDATE financing.project_tasks SET assignee_id=$1 WHERE id=$2', ['auth0|other-person', task.id]);
  const beforeDeniedTask = (await db.query('SELECT status,schedule_type,planned_start_date,due_date FROM financing.project_tasks WHERE id=$1', [task.id])).rows[0];
  currentPermissions = ['financing.task:update_own'];
  await db.query("UPDATE \"authorization\".role_permission SET granted = (permission_code = 'financing.task:update_own')");
  const otherTask = await respond(`/financing/projects/${project.id}?/updateOwnTaskStatus`, {
    method: 'POST', headers: { Accept: 'application/json', 'X-SvelteKit-Action': 'true' },
    body: new URLSearchParams({ taskId: task.id, status: 'in_progress', scheduleType:'period',plannedStartDate:'2026-01-01',dueDate:'2026-01-02' }),
  });
  assert.equal(otherTask.status, 200);
  const ownTaskResult = await otherTask.json();
  assert.equal(ownTaskResult.type, 'failure');
  assert.equal(ownTaskResult.status, 403);
  assert.deepEqual((await db.query('SELECT status,schedule_type,planned_start_date,due_date FROM financing.project_tasks WHERE id=$1', [task.id])).rows[0], beforeDeniedTask); checks++;
  await db.query('UPDATE financing.project_tasks SET assignee_id=$1 WHERE id=$2',[account.user_id,task.id]);
  const beforeOwn=(await db.query('SELECT schedule_type,planned_start_date,due_date FROM financing.project_tasks WHERE id=$1',[task.id])).rows[0];
  await action(`${taskPath}?/updateOwnTaskStatus`,{taskId:task.id,status:'completed',scheduleType:'period',plannedStartDate:'2026-01-01',dueDate:'2026-01-02'});
  assert.deepEqual((await db.query('SELECT schedule_type,planned_start_date,due_date FROM financing.project_tasks WHERE id=$1',[task.id])).rows[0],beforeOwn);
  currentPermissions = [...PERMISSION_CODES];
  await db.query('UPDATE "authorization".role_permission SET granted = true');
  const denied = await respond('/management/people?/createPerson', { method: 'POST', headers: { Origin: 'https://other.test' } });
  assert.equal(denied.status, 403); checks++;
  assert.equal(opened, closed);
  assert.ok(peak <= 1);
  console.log(JSON.stringify({ checks, opened, closed, peak, queries, auth0Requests, database: 'local PGlite', externalServices: 'mocked' }));
} finally {
  Client.prototype.connect = originals.connect; Client.prototype.query = originals.query; Client.prototype.end = originals.end;
  Object.assign(GatewayClient.prototype, gatewayOriginals);
  globalThis.fetch = originals.fetch;
  await db.close();
}
