import assert from 'node:assert/strict';
import test from 'node:test';
import { requireActiveModel } from '../model-eligibility.mjs';

test('only explicit active identity passes the parameterized eligibility lookup', async () => {
  const version = '0'.repeat(20);
  for (const rows of [[], [{ status: 'suspended', reason: 'data_quality' }], [{ status: 'active' }]]) {
    const client = { query: async (sql, params) => {
      assert.equal(sql, 'SELECT status,reason FROM financing_model.model_eligibility WHERE model_version=$1');
      assert.deepEqual(params, [version]);
      return { rows };
    } };
    if (rows[0]?.status === 'active') await requireActiveModel(client, version);
    else await assert.rejects(requireActiveModel(client, version), /Model suspended/);
  }
});

test('invalid identity does not query and database failures never permit use', async () => {
  for (const version of [undefined, '', 'invalid']) {
    await assert.rejects(requireActiveModel({ query: () => assert.fail('unexpected query') }, version), /Invalid model identity/);
  }
  await assert.rejects(requireActiveModel({ query: async () => { throw new Error('unavailable'); } }, '0'.repeat(20)), /unavailable/);
});
