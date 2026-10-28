import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGate } from '../ci-gate.mjs';

const success = { unit: { result: 'success' }, 'build-visual': { result: 'success' } };
const queue = { type: 'merge_queue' };
const required = { type: 'required_status_checks', parameters: {
  required_status_checks: [{ context: 'Monorepo CI', integration_id: 15368 }],
} };

test('PR admission fails closed without queue protection and the required Actions check', () => {
  for (const rules of [[], [queue], [required], [queue, {
    ...required, parameters: { required_status_checks: [{ context: 'Monorepo CI', integration_id: 42 }] },
  }]]) assert.throws(() => checkGate('pull_request', {}, rules), /requires an enforced merge queue/);
  assert.match(checkGate('pull_request', {}, [queue, required]), /admitted/);
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
