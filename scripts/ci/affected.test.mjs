import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affected, projects } from './affected.mjs';
import { verify } from './gate.mjs';

test('service bindings and shared contracts include consumers without global imports', () => {
  const plan = affected(['data/src/contracts.ts']);
  for (const p of ['data', 'gateway', 'dashboard', 'ingest', 'quant']) assert.equal(plan[p], true);
  assert.equal(plan.choice, false);
  assert.equal(affected(['dashboard/migrations/next.sql']).ingest, true);
  assert.equal(affected(['ingest/migrations/next.sql']).dashboard, true);
  assert.equal(affected(['choice/src/main.cpp']).data, true);
  assert.equal(affected(['quant/online/worker.ts']).dashboard, true);
  assert.ok(projects.every(p => affected(['.github/workflows/ci.yml'])[p]));
  assert.ok(projects.every(p => !affected(['README.md'])[p]));
});

test('aggregation rejects failure, cancellation, missing analysis and unexpected skips', () => {
  const plan = Object.fromEntries(projects.map(p => [p, String(p === 'data')]));
  const needs = Object.fromEntries(projects.map(p => [p, { result: p === 'data' || p === 'dashboard' ? 'success' : 'skipped' }]));
  needs.changes = { result: 'success' }; needs.integration = { result: 'success' };
  assert.doesNotThrow(() => verify(plan, needs));
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) assert.throws(() => verify(plan, { ...needs, data: { result } }));
  assert.throws(() => verify(plan, { ...needs, changes: { result: 'failure' } }));
  assert.throws(() => verify({}, needs), /Invalid change plan/);
  assert.throws(() => verify({ ...plan, data: undefined }, needs), /Invalid change plan/);
  assert.throws(() => verify({ ...plan, data: 'unknown' }, needs), /Invalid change plan/);
});
