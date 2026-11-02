import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGate } from '../ci-gate.mjs';

const success = { unit: { result: 'success' }, 'build-visual': { result: 'success' } };
test('pull requests are admitted without full acceptance and unaffected changes need none', () => {
  assert.match(checkGate('pull_request', {}), /admitted/);
  assert.match(checkGate('pull_request', {}, false), /No Dashboard changes/);
});

test('queue and manual acceptance reject any failed, skipped, cancelled or missing job', () => {
  for (const event of ['merge_group', 'workflow_dispatch']) {
    assert.match(checkGate(event, success), /All full checks passed/);
    for (const job of Object.keys(success)) {
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        assert.throws(() => checkGate(event, { ...success, [job]: { result } }), /did not pass/);
      }
    }
  }
  assert.throws(() => checkGate('push', success), /Unexpected CI event/);
});
