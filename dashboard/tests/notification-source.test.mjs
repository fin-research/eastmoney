import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationSource } from '../src/lib/server/notification-source.ts';
import { defaultFlows } from '../src/lib/trading-workflow/model.ts';

const node = { id: 'test', flowIds: ['loan'], nextIds: [], parentId: null, kind: 'task', title: '测试提醒', detail: '', startTime: '09:00', endTime: '09:30' };
function environment(now, nodes = [node]) {
  const calls = { identity: 0, progress: 0, sent: [] };
  const env = {
    DB: { prepare(sql) { return { bind() { return this; }, async first() {
      if (sql.includes('financing_reminder_checkpoint')) return { generation: 0, checked_at: now - 60_000, next_scan_at: now + 60_000 };
      if (sql.includes('trading_workflow_config')) return { version: 1, nodes: JSON.stringify({ flows: defaultFlows, nodes }) };
      if (sql.includes('trading_workflow_progress')) { calls.progress++; return null; }
      throw new Error(sql);
    } }; } },
    IDENTITY: { async fetch() { calls.identity++; throw new Error('Notification scan must not query Auth0'); } },
    MESSENGER: { async fetch(request) { calls.sent.push(await request.json()); return Response.json({ id: 'notification-test' }); } }
  };
  return { env, calls };
}

for (const [date, expected] of [
  ['2026-09-20T09:00:00+08:00', 0], // Sunday
  ['2026-09-21T00:00:00+08:00', 0],
  ['2026-09-21T08:59:00+08:00', 0],
  ['2026-09-21T09:00:00+08:00', 1],
  ['2026-09-21T09:04:00+08:00', 1],
  ['2026-09-21T09:05:00+08:00', 0],
  ['2026-09-21T09:30:00+08:00', 1],
  ['2026-09-21T09:35:00+08:00', 0]
]) test(`notification scan uses supplied D1 subscribers in the due window: ${date}`, async t => {
  const now = Date.parse(date);
  t.mock.method(Date, 'now', () => now);
  const { env, calls } = environment(now);
  const response = await notificationSource(new Request('https://notifications.internal/scan', { method: 'POST', body: JSON.stringify({ scheduledTime: now, userIds:['auth0|test','auth0|test'] }) }), env);
  assert.equal(response.status, 200);
  assert.equal(calls.identity, 0);
  assert.equal(calls.progress, expected);
  assert.equal(calls.sent.length, expected);
  if (expected) assert.deepEqual(calls.sent[0].userIds, ['auth0|test']);
});

test('retired eligibility endpoint no longer calls the identity service', async () => {
  const { env, calls } = environment(Date.now());
  const request = () => new Request('https://notifications.internal/eligible');
  assert.equal((await notificationSource(request(), env)).status, 404);
  assert.equal(calls.identity, 0);
});

test('scan validates recipient IDs and an empty D1 audience generates no trading reminders', async t => {
  const now=Date.parse('2026-09-21T09:00:00+08:00');t.mock.method(Date,'now',()=>now);
  const {env,calls}=environment(now);
  const request=userIds=>new Request('https://notifications.internal/scan',{method:'POST',body:JSON.stringify({scheduledTime:now,userIds})});
  assert.equal((await notificationSource(request(['invalid']),env)).status,400);
  assert.equal((await notificationSource(request([]),env)).status,200);
  assert.equal(calls.sent.length,0);assert.equal(calls.identity,0);
});
