import { afterEach, expect, test, vi } from 'vitest';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => JSON.stringify({
  account_id: 'test', workflows: [{ name: 'economic-indicator-sync' }],
})) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

async function plan(subscriptions = []) {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetch = vi.fn(async path => Response.json({ success: true, result:
    path.includes('/event_subscriptions/') ? subscriptions : [{ queue_name: 'messenger-workflow-events', queue_id: 'queue' }],
  }));
  vi.stubGlobal('fetch', fetch);
  await import('../scripts/sync-workflow-subscriptions.mjs');
  return { log, fetch };
}
test('a configured workflow without a subscription is planned for creation and nothing is written', async () => {
  const { log, fetch } = await plan();
  expect(log.mock.calls.flat()).toEqual(['create messenger-economic-indicator-sync: instance.errored,instance.terminated,instance.completed']);
  expect(fetch.mock.calls.every(([_path, options]) => options.method === 'GET')).toBe(true);
});
test('an exact existing subscription is unchanged', async () => {
  const { log } = await plan([{
    name: 'messenger-economic-indicator-sync', enabled: true,
    source: { type: 'workflows.workflow', workflow_name: 'economic-indicator-sync' },
    destination: { queue_id: 'queue' }, events: ['instance.errored', 'instance.terminated', 'instance.completed'],
  }]);
  expect(log.mock.calls.flat()).toEqual(['unchanged messenger-economic-indicator-sync: instance.errored,instance.terminated,instance.completed']);
});
