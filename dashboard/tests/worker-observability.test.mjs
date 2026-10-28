import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Worker tracing is explicitly enabled and persisted without changing logs or adding external destinations', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.observability.enabled, true);
  assert.deepEqual(config.observability.logs, { head_sampling_rate: 1 });
  assert.deepEqual(config.observability.traces, {
    enabled: true,
    head_sampling_rate: 0.1,
    persist: true,
  });
});
