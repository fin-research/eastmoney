import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affected, declared, projects } from './affected.mjs';
import { verify } from './gate.mjs';

test('service bindings and shared contracts include consumers without global imports', () => {
  const plan = affected(['data/src/contracts.ts']);
  for (const p of ['data', 'gateway', 'dashboard', 'ingest', 'quant']) assert.equal(plan[p], true);
  assert.equal(plan.choice, false);
  assert.equal(affected(['dashboard/migrations/next.sql']).ingest, true);
  assert.equal(affected(['ingest/migrations/next.sql']).dashboard, true);
  assert.equal(affected(['choice/src/main.cpp']).data, true);
  assert.equal(affected(['dashboard/src/lib/permissions.ts']).gateway, true);
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

test('shared dependency policy changes require every project', () => {
  for (const path of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc']) {
    assert.ok(projects.every(project => affected([path])[project]), path);
  }
});

test('declared scope replaces dependency expansion but never narrows CI or dependency files', () => {
  const only = labels => declared(labels);
  const plan = affected(['data/src/contracts.ts'], false, only(['ci:data']));
  assert.deepEqual(projects.filter(p => plan[p]), ['data']);
  const multi = affected(['data/src/contracts.ts'], false, only(['ci:data', 'ci:gateway', 'bug']));
  assert.deepEqual(projects.filter(p => multi[p]), ['gateway', 'data']);
  for (const path of ['.github/workflows/ci.yml', 'scripts/ci/gate.mjs', 'package.json', 'pnpm-lock.yaml']) {
    assert.ok(projects.every(p => affected([path], false, only(['ci:data']))[p]), path);
  }
  const skills = affected(['gateway/src/a.ts', 'skills/x/SKILL.md'], false, only(['ci:gateway']));
  assert.deepEqual(projects.filter(p => skills[p]), ['gateway']);
  assert.ok(projects.every(p => affected(['skills/x/SKILL.md'])[p]));
  assert.ok(projects.every(p => affected(['data/src/a.ts'], false, only(['ci:all']))[p]));
  assert.deepEqual(affected(['data/src/a.ts'], false, only(['bug'])), affected(['data/src/a.ts']));
  assert.throws(() => declared(['ci:unknown']), /Unknown CI scope label/);
});
