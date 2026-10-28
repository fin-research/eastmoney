import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readReminderCheckpoint, invalidateReminderCheckpoint, saveEmptyReminderCheckpoint, withReminderCheckpointInvalidation } from '../src/lib/server/financing/reminder-checkpoint.js';
import { runScheduledReminderCheck } from '../src/lib/server/financing/reminder-scheduler.js';
import { sendDueReminders } from '../src/lib/server/financing/reminders.js';

function storage(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const migration = readFileSync(new URL('../migrations/1020_financing_reminder_checkpoint.sql', import.meta.url), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  return { prepare(sql) { let values = []; return {
    bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; }
  }; } };
}

test('an idle hour opens Neon once; the next hourly boundary and business writes rescan', async t => {
  const DB = storage(t);
  let opened = 0, closed = 0;
  const env = { DB, HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } };
  const start = Date.parse('2026-09-20T16:00:00Z');
  const scan = scheduledTime => runScheduledReminderCheck({ scheduledTime, env,
    createDatabase() { opened++; return { async close() { closed++; } }; },
    async send({ asOf }) { return { asOf: asOf.toISOString(), count: 0, candidateCount: 0, dryRun: false, results: [] }; }
  });
  for (let minute = 0; minute < 60; minute++) await scan(start + minute * 60_000);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  await scan(start + 3_600_000);
  assert.equal(opened, 2);
  await invalidateReminderCheckpoint(DB);
  await scan(start + 3_660_000);
  assert.equal(opened, 3);
  // A replay older than the proof must never reuse a later empty result.
  await scan(start - 60_000);
  assert.equal(opened, 4);
});

test('a racing or failed mutation cannot publish a stale empty checkpoint', async t => {
  const DB = storage(t), start = Date.parse('2026-09-20T16:00:00Z');
  const before = await readReminderCheckpoint(DB);
  await withReminderCheckpointInvalidation(DB, async () => {
    assert.equal((await readReminderCheckpoint(DB)).next_scan_at, 0);
    const during = await readReminderCheckpoint(DB);
    await saveEmptyReminderCheckpoint(DB, during.generation, start);
  });
  assert.equal((await readReminderCheckpoint(DB)).next_scan_at, 0);
  await saveEmptyReminderCheckpoint(DB, before.generation, start);
  assert.equal((await readReminderCheckpoint(DB)).next_scan_at, 0);
  await assert.rejects(withReminderCheckpointInvalidation(DB, async () => {
    const during = await readReminderCheckpoint(DB);
    await saveEmptyReminderCheckpoint(DB, during.generation, start);
    throw new Error('partial action failure');
  }), /partial action failure/);
  assert.equal((await readReminderCheckpoint(DB)).next_scan_at, 0);
});

test('due, failed and dry-run scans retain minute retries and always close Neon', async t => {
  const DB = storage(t), env = { DB, HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } };
  let closed = 0;
  for (const result of [
    { candidateCount: 1, count: 0, dryRun: false, results: [] },
    { candidateCount: 1, count: 1, dryRun: false, results: [{ status: 'failed' }] },
    { candidateCount: 0, count: 0, dryRun: true, results: [] },
    null
  ]) {
    const promise = runScheduledReminderCheck({ scheduledTime: Date.parse('2026-09-20T16:05:00Z'), env,
      createDatabase: () => ({ async close() { closed++; } }),
      async send() { if (!result) throw new Error('upstream failure'); return { asOf: '2026-09-20T16:05:00Z', ...result }; }
    });
    if (result) await promise; else await assert.rejects(promise, /upstream failure/);
    assert.equal((await readReminderCheckpoint(DB)).next_scan_at, 0);
  }
  assert.equal(closed, 4);
});

test('an inactive recipient is not mistaken for an empty SQL candidate set', async () => {
  const db = { prepare: () => ({ all: async () => [{ recipientMode: 'assignee', assigneeId: 'inactive' }] }) };
  const result = await sendDueReminders({ asOf: '2026-09-20T16:00:00Z', db,
    config: { MESSENGER: {} }, directory: async () => [] });
  assert.equal(result.count, 0);
  assert.equal(result.candidateCount, 1);
});
