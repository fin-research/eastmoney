import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { financingPersonView, publicIdentity } from '../src/lib/identity.ts';

test('one site identity supplies financing projections without changing its subject or exposing authorization metadata', () => {
  const identity = { id: 'access-id', auth0Id: 'auth0|signed-id', email: 'user@18.cn', issuedAt: 1, expiresAt: 100,
    authorization: { name: '经办', roles: [{id:'rol_Handler',name:'经办'}], permissions: ['financing.task:update_own'], mode:'enforce', picture:'' } };
  assert.deepEqual(publicIdentity(identity), { id: 'access-id', auth0Id: 'auth0|signed-id', email: 'user@18.cn' });
  const person = financingPersonView(identity);
  assert.equal(person.id, identity.auth0Id);
  assert.equal(person.personId, identity.auth0Id);
  assert.equal(identity.id, 'access-id');
  assert.equal(financingPersonView({ ...identity, authorization: undefined }), null);
  assert.equal(financingPersonView({ ...identity, auth0Id: null }), null);
});

test('financing consumes central authentication and all live management clients use one Secret', async () => {
  const [auth, hooks, provider, configText, declarations] = await Promise.all([
    readFile(new URL('../src/lib/server/gateway-context.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks.server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/server/auth0-directory.ts', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.d.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(auth, /verifyAccess|requireHuman|getSessionUser|createNeonAuthClient/);
  assert.match(auth, /env\.GATEWAY_CONTEXT/);
  assert.match(hooks, /event\.locals\.user = authorization.user/);
  assert.doesNotMatch(declarations, /financingUser/);
  const config = JSON.parse(configText);
  assert.deepEqual(config.secrets.required.filter(name => name.includes('AUTH0')), []);
  assert.equal(Object.keys(config.vars).filter(name => name.endsWith('MANAGEMENT_CLIENT_ID')).length, 0);
  assert.match(provider, /identityJson/);
});
