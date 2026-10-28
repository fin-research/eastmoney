import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowEdgePath } from '../src/lib/trading-workflow/edge-path.ts';
test('unequal source heights share a horizontal merge and only descend toward the target', () => {
  const left = workflowEdgePath(100, 120, 300, 400, 362);
  const right = workflowEdgePath(500, 324, 300, 400, 362);
  assert.equal(left, 'M 100 120 L 100 354 Q 100 362 108 362 L 292 362 Q 300 362 300 370 L 300 400');
  assert.equal(right, 'M 500 324 L 500 354 Q 500 362 492 362 L 308 362 Q 300 362 300 370 L 300 400');
  assert.equal(workflowEdgePath(300, 120, 300, 400, 362), 'M 300 120 L 300 400');
});
