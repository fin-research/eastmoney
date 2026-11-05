import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affected, declared, projects, covered } from './affected.mjs';
import { passedRun, prNumber } from './reuse.mjs';
import { verify } from './gate.mjs';

test('service bindings and shared contracts include consumers without global imports', () => {
  const plan = affected(['data/src/contracts.ts']);
  for (const p of ['data', 'gateway', 'dashboard', 'ingest', 'quant']) assert.equal(plan[p], true);
  assert.equal(affected(['dashboard/migrations/next.sql']).ingest, true);
  assert.equal(affected(['ingest/migrations/next.sql']).dashboard, true);
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

test('a queue run that reuses a passed PR run skips every project', () => {
  const plan = Object.fromEntries(projects.map(p => [p, 'false']));
  const needs = Object.fromEntries(projects.map(p => [p, { result: p === 'dashboard' ? 'success' : 'skipped' }]));
  needs.changes = { result: 'success' }; needs.integration = { result: 'skipped' };
  assert.doesNotThrow(() => verify({ ...plan, reused: 'true' }, needs));
  assert.throws(() => verify({ ...plan, gateway: 'true', reused: 'true' }, needs), /gateway/);
});

test('reuse needs the newest non-cancelled PR run to have passed', () => {
  const run = (conclusion, id = 1, name = 'Eastmoney CI') => ({ id, name, conclusion });
  assert.equal(passedRun([run('cancelled', 3), run('success', 2)]).id, 2);
  assert.equal(passedRun([run('failure', 3), run('success', 2)]), null);
  assert.equal(passedRun([run(null, 3), run('success', 2)]), null);
  assert.equal(passedRun([run('success', 2, 'Other')]), null);
  assert.equal(passedRun([]), null);
  assert.equal(prNumber('gh-readonly-queue/main/pr-34-194354e9'), '34');
  assert.equal(prNumber('refs/heads/main'), null);
});

test('reuse requires the PR run to have tested every project the queue run needs', () => {
  const plan = Object.fromEntries(projects.map(p => [p, p === 'data' ? 'true' : 'false']));
  assert.equal(covered(affected(['data/x.ts'], false, declared(['ci:data'])), plan), true);
  assert.equal(covered(affected(['data/x.ts'], false, declared(['ci:data', 'ci:quant'])), plan), false);
  assert.equal(covered(affected(['data/src/x.ts']), plan), false);
  assert.equal(covered(affected(['README.md']), {}), true);
  assert.equal(covered(affected(['data/src/x.ts']), undefined), false);
});
