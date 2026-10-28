import assert from 'node:assert/strict';
import test from 'node:test';
import { scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';
import { auth0ImportUser, buildAuth0Import } from '../../scripts/financing/lib/auth0-migration.mjs';
import { createAuth0ManagementClient } from './fixtures/legacy-auth/auth0-client.js';

const require = createRequire(import.meta.url);
const { onExecutePreUserRegistration } = require('./fixtures/auth0/pre-registration.cjs');
const { onExecutePostLogin } = require('./fixtures/auth0/post-login.cjs');
const { compileDataAdminQuery } = await tsImport('../../src/lib/server/financing/data-admin-query.ts', import.meta.url);
const id = '11111111-1111-4111-8111-111111111111';

test('scrypt import preserves salt text and the exact Better Auth parameters', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const expected = scryptSync('Known-fixture-A1!', salt, 64, { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  const imported = auth0ImportUser({ id, email: 'Example@18.cn', password: `${salt}:${expected}`, role: 'reviewer', person_id: 'person', active: true });
  assert.deepEqual(imported.custom_password_hash, { algorithm: 'scrypt', hash: { value: expected, encoding: 'hex' }, salt: { value: salt, encoding: 'utf8' }, cost: 16384, blockSize: 16, parallelization: 1, keylen: 64 });
  assert.equal(imported.user_id, id); assert.equal(imported.email_verified, false);
  assert.equal(imported.app_metadata.neon_role, 'reviewer');
  assert.throws(() => buildAuth0Import([{ id, email: 'other@example.com' }]), /domain/);
  assert.throws(() => auth0ImportUser({ id, email: 'user@18.cn', password: 'unknown' }), /Unsupported/);
});

test('registration restricts the exact domain and login requires verification for new accounts', async () => {
  const denied = []; const claims = [];
  const api = { access: { deny: (...args) => denied.push(args) }, idToken: { setCustomClaim: (...args) => claims.push(args) } };
  await onExecutePreUserRegistration({ connection: { name: 'eastmoney-email' }, user: { email: 'user@18.cn.evil.test' } }, api);
  assert.equal(denied.length, 1);
  const base = { client: { client_id: 'site' }, secrets: { EASTMONEY_CLIENT_ID: 'site' }, user: { user_id: `auth0|${id}`, email: 'user@18.cn', email_verified: false } };
  await onExecutePostLogin(base, api); assert.equal(denied.length, 2);
  await onExecutePostLogin({ ...base, user: { ...base.user, app_metadata: { migrated_from: 'neon', neon_auth_user_id: id, neon_email: base.user.email } } }, api);
  assert.equal(denied.length, 2); assert.deepEqual(claims[0], ['eastmoney_user_id', `auth0|${id}`]);
  await onExecutePostLogin({ ...base, user: { ...base.user, app_metadata: { migrated_from: 'neon', neon_auth_user_id: '22222222-2222-4222-8222-222222222222' } } }, api);
  assert.equal(denied.length, 3);
});

test('data editor binds values, enforces table/column ownership and requires complete mutation keys', () => {
  const query = compileDataAdminQuery('bond', 'PATCH', new URLSearchParams({ id: 'eq.42', updated_at: 'eq.2026-09-01' }), { name: "x'); DROP TABLE financing.people; --" });
  assert.ok(!query.sql.includes('DROP TABLE')); assert.equal(query.values[2], "x'); DROP TABLE financing.people; --");
  assert.ok(query.sql.includes('"id" = $1')); assert.ok(query.sql.includes('"updated_at" = $2'));
  assert.throws(() => compileDataAdminQuery('people', 'GET', new URLSearchParams()), /不支持/);
  assert.throws(() => compileDataAdminQuery('bond', 'DELETE', new URLSearchParams()), /完整主键/);
  assert.throws(() => compileDataAdminQuery('bond', 'PATCH', new URLSearchParams({ id: 'eq.42' }), { id: 43 }), /只读|主键/);
  assert.throws(() => compileDataAdminQuery('bond', 'GET', new URLSearchParams({ select: 'password' })), /白名单/);
  assert.throws(() => compileDataAdminQuery('bond', 'GET', new URLSearchParams({ limit: '100000' })), /范围/);
});

test('Auth0 authorization uses one token and preserves the existing role/permission vocabulary', async () => {
  let tokens = 0;
  const client = createAuth0ManagementClient({ domain: 'example.eu.auth0.com', clientId: 'client', clientSecret: 'fixture', roleIds: { admin: 'role-admin', handler: 'role-handler', reviewer: 'role-reviewer' },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/oauth/token') { tokens++; return Response.json({ access_token: 'fixture-token' }); }
      if (path.endsWith('/roles')) return Response.json([{ id: 'role-handler' }]);
      if (path.endsWith('/permissions')) return Response.json([{ resource_server_identifier: 'https://eastmoney.hasbai.xyz/financing', permission_name: 'own_task_update' }, { resource_server_identifier: 'https://other.test', permission_name: 'data_manage' }]);
      return Response.json({ email: 'user@18.cn', email_verified: true, blocked: false });
    },
  });
  assert.deepEqual(await client.authorization(`auth0|${id}`), { role: 'handler', permissions: ['own_task_update'], email: 'user@18.cn' });
  assert.equal(tokens, 1);
});

test('management credentials never follow redirects and use a Workers-supported request mode', async () => {
  let requests = 0;
  const client = createAuth0ManagementClient({ domain: 'redirect-fixture.eu.auth0.com', clientId: 'redirect-client', clientSecret: 'fixture', roleIds: {},
    fetchImpl: async (_url, init) => {
      requests++;
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/token' } });
    },
  });
  await assert.rejects(client.request('users'), (error) => error.status === 503 && error.code === 'AUTH0_REQUEST_FAILED');
  assert.equal(requests, 1);
});
