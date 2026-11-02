import test from 'node:test';
import assert from 'node:assert/strict';
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
