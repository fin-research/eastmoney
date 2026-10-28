import assert from 'node:assert/strict';
import test from 'node:test';
import { publishArchivedResult } from '../publication.mjs';
const key = 'quant-trial/runs/2026-09-18/bond-test/result.json';
async function fixture() {
  const payload = { as_of_date: '2026-09-18', online_run: { runtime: 'cloudflare-workflow', workflow_id: 'bond-test', model_version: '0123456789abcdef0123' } };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
  const object = { size: bytes.length, customMetadata: { sha256 }, arrayBuffer: async () => bytes };
  const calls = [];
  class Client {
    async connect() { calls.push('connect'); }
    async query(sql, params) { calls.push([sql, params]); return { rows: [sql.includes('model_eligibility')?{status:'active'}:{ run_id: 'stable-daily-id' }] }; }
    async end() { calls.push('end'); }
  }
  const env = { ARTIFACTS: { get: async () => object }, HYPERDRIVE: { connectionString: 'test' } };
  return { payload, object, calls, Client, env };
}
test('publication sends the frozen result to the atomic adapter and closes the connection', async () => {
  const f = await fixture();
  const output = await publishArchivedResult(f.env, key, f.Client);
  assert.equal(output.run_id, 'stable-daily-id');
  assert.equal(output.result_key, key);
  assert.equal(f.calls[0], 'connect');
  assert.deepEqual(f.calls[1][1], [f.payload.online_run.model_version]);
  assert.deepEqual(JSON.parse(f.calls[2][1][0]), f.payload);
  assert.equal(f.calls[2][1][1], key);
  assert.equal(f.calls.at(-1), 'end');
  class FailingClient extends f.Client {
    async query(sql, params) {
      if (sql.includes('model_eligibility')) return super.query(sql, params);
      throw new Error('write failed');
    }
  }
  await assert.rejects(publishArchivedResult(f.env, key, FailingClient), /write failed/);
  assert.equal(f.calls.at(-1), 'end');
});
test('suspended and unreviewed identities cannot publish even a valid complete archive',async()=>{
  for(const rows of [[],[{status:'suspended',reason:'data_quality'}]]){
    const f=await fixture();
    class SuspendedClient extends f.Client {
      async query(sql,params){f.calls.push([sql,params]);assert.ok(sql.includes('model_eligibility'));return {rows};}
    }
    await assert.rejects(publishArchivedResult(f.env,key,SuspendedClient),/Model suspended/);
    assert.equal(f.calls.filter(x=>Array.isArray(x)).length,1);
    assert.equal(f.calls.at(-1),'end');
  }
});
test('publication refuses untrusted, missing, oversized or corrupt archives before connecting', async () => {
  for (const damage of [
    f => { f.object.customMetadata.sha256 = '0'.repeat(64); },
    f => { delete f.object.customMetadata.sha256; },
    f => { f.object.size = 256 * 1024 + 1; },
    f => { f.env.ARTIFACTS.get = async () => null; },
  ]) {
    const f = await fixture(); damage(f);
    await assert.rejects(publishArchivedResult(f.env, key, f.Client));
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture();
  await assert.rejects(publishArchivedResult(f.env, '../result.json', f.Client), /Invalid/);
  await assert.rejects(publishArchivedResult(f.env, key.replace('bond-test', 'other'), f.Client), /provenance/);
  assert.deepEqual(f.calls, []);
});
