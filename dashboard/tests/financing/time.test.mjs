import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { types } from 'pg';
import { financingTimestamp, financingToday, formatFinancingTimestamp } from '../../src/lib/financing/time.js';

test('source timestamps are UTC+8 and explicit instants keep their original precision', () => {
  assert.equal(financingTimestamp('2026-09-08 00:30:00.123456'), '2026-09-08T00:30:00.123456+08:00');
  assert.equal(financingTimestamp('2026-09-07 16:30:00.123456+00'), '2026-09-07T16:30:00.123456+00:00');
  assert.equal(Date.parse(financingTimestamp('2026-09-08 00:30:00')), Date.parse('2026-09-07T16:30:00Z'));
  assert.equal(formatFinancingTimestamp('2026-09-08 00:30:00'), formatFinancingTimestamp('2026-09-07T16:30:00Z'));
  assert.equal(financingToday(new Date('2026-09-07T16:30:00Z')), '2026-09-08');
  for (const value of ['2026-09-08', '2026-02-30 08:30:00', '2026-09-08 24:30:00']) {
    assert.throws(() => financingTimestamp(value), /时间戳/);
  }
});

test('financing date parsing is per client and never modifies global pg parsers', async () => {
  const original = [1082, 1114, 1184].map(oid => types.getTypeParser(oid, 'text'));
  const { createPostgresDatabase } = await import('../../src/lib/financing/postgres.js');
  const db = createPostgresDatabase('postgres://test:test@localhost/unused');
  for (const [index, oid] of [1082, 1114, 1184].entries()) assert.equal(types.getTypeParser(oid, 'text'), original[index]);
  assert.equal(db.client.getTypeParser(1082, 'text')('2026-09-08'), '2026-09-08');
  assert.equal(db.client.getTypeParser(1114, 'text')('2026-09-08 00:30:00'), '2026-09-08T00:30:00+08:00');
  assert.equal(db.client.getTypeParser(1184, 'text')('2026-09-07 16:30:00.123456+00'), '2026-09-07T16:30:00.123456+00:00');
  await db.close();
});

test('timestamp display and source parsing do not depend on the host timezone', () => {
  const module = new URL('../../src/lib/financing/time.js', import.meta.url).href;
  const script = `import { financingTimestamp, formatFinancingTimestamp } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify([financingTimestamp('2026-09-08 00:30:00'),formatFinancingTimestamp('2026-09-07T16:30:00Z')]))`;
  const results = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles'].map(TZ => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  });
  assert.equal(new Set(results).size, 1);
});
