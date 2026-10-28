import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { management } from './lib/auth0-management.mjs';

const root = new URL('../', import.meta.url);
const apply = process.argv.includes('--apply');
const mappingIndex = process.argv.indexOf('--person-map');
const mappings = mappingIndex < 0 ? {} : JSON.parse(await readFile(process.argv[mappingIndex + 1], 'utf8'));
if (!mappings || Array.isArray(mappings) || typeof mappings !== 'object' || Object.values(mappings).some(id => typeof id !== 'string' || !/^auth0\|\S+$/.test(id))) throw new Error('人员映射须为旧人员 ID 到 Auth0 ID 的 JSON 对象');
const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connection) throw new Error('缺少 DATABASE_URL_UNPOOLED / DATABASE_URL');
const connectionUrl = new URL(connection);
if (connectionUrl.hostname.includes('-pooler')) throw new Error('迁移必须使用 Neon 直连地址');
async function list(path) {
  const rows = [];
  for (let page = 0; page < 20; page++) {
    const batch = management('get', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Auth0 列表响应无效');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error('Auth0 列表超过处理上限');
}
const users = (await list('users?search_engine=v3&q=' + encodeURIComponent('identities.connection:"eastmoney-email"')))
  .filter(user => user.identities?.some(identity => identity.connection === 'eastmoney-email'));
const roles = await list('roles');
const client = new Client({ connectionString: connection, application_name: 'eastmoney-unified-permissions-migration' });
await client.connect();
try {
  const exists = (await client.query("SELECT to_regclass('financing.people') IS NOT NULL AS present")).rows[0].present;
  const people = exists ? (await client.query('SELECT id, auth0_user_id FROM financing.people ORDER BY id')).rows : [];
  if (exists && Object.keys(mappings).some(id => !people.some(person => person.id === id))) throw new Error('映射包含不存在的旧人员 ID');
  const missing = people.filter(person => !users.some(user => user.user_id === (mappings[person.id] ?? person.auth0_user_id)));
  const references = exists ? (await client.query(`SELECT
    (SELECT count(*)::int FROM financing.projects WHERE owner_id IS NOT NULL) AS project_owners,
    (SELECT count(*)::int FROM financing.project_tasks WHERE assignee_id IS NOT NULL) AS task_assignees,
    (SELECT count(*)::int FROM financing.liability_weekly_report_runs WHERE generated_by_person_id IS NOT NULL) AS report_authors`)).rows[0] : {};
  console.log(JSON.stringify({ database: connectionUrl.pathname.slice(1), host: connectionUrl.hostname, apply, people: people.length, auth0Users: users.length, roles: roles.length, references, unmappedPersonIds: missing.map(person => person.id) }));
  if (missing.length) throw new Error('存在未确认的 Auth0 人员映射，迁移未执行');
  if (!apply) process.exitCode = 0;
  else {
    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('eastmoney-unified-permissions-migration', 0))");
      await client.query("SELECT set_config('migration.person_mapping', $1, true), set_config('migration.auth0_users', $2, true), set_config('migration.auth0_roles', $3, true)", [JSON.stringify(mappings), JSON.stringify(users.map(({user_id}) => ({user_id}))), JSON.stringify(roles.map(({id,name}) => ({id,name})))]);
      await client.query('CREATE SCHEMA IF NOT EXISTS "authorization"');
      await client.query('CREATE TABLE IF NOT EXISTS "authorization".schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = [];
      for (const name of (await readdir(new URL('authorization-migrations/', root))).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
        if ((await client.query('SELECT 1 FROM "authorization".schema_migration WHERE name = $1', [name])).rowCount) continue;
        await client.query(await readFile(new URL(`authorization-migrations/${name}`, root), 'utf8'));
        await client.query('INSERT INTO "authorization".schema_migration (name) VALUES ($1)', [name]);
        applied.push('authorization/' + name);
      }
      const name = '0032_unified_permissions.sql';
      if (!(await client.query('SELECT 1 FROM financing.schema_migrations WHERE name = $1', [name])).rowCount) {
        const sql = (await readFile(new URL(`financing-migrations/${name}`, root), 'utf8')).replace(/^\s*BEGIN\s*;/i, '').replace(/COMMIT;\s*$/i, '');
        await client.query(sql);
        await client.query('INSERT INTO financing.schema_migrations (name) VALUES ($1)', [name]);
        applied.push('financing/' + name);
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ applied, status: 'migrated' }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.end(); }
