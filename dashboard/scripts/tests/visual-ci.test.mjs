import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateManifest, validateExecution } from '../visual-coverage.mjs';
import { verifyCandidate } from '../visual-baselines.mjs';

const manifest = () => ({ inventory: { root: 'pages', suffix: '.svelte' }, baselineTemplate: 'snapshots/{project}/{snapshot}',
  pages: [{ source: 'pages/Home.svelte', scenarios: ['home'] }], scenarios: [{ id: 'home', kind: 'screenshot',
    evidence: [{ spec: 'home.spec.mjs', test: 'home renders', projects: ['mobile'], snapshots: ['home.png'] }] }] });
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'visual-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'pages')); mkdirSync(join(root, 'snapshots/mobile'), { recursive: true });
  writeFileSync(join(root, 'pages/Home.svelte'), '<h1>Home</h1>');
  writeFileSync(join(root, 'home.spec.mjs'), ''); writeFileSync(join(root, 'snapshots/mobile/home.png'), 'png');
  return root;
}
test('new page cannot silently enter the denominator; reasoned exemptions stay visible', t => {
  const root = setup(t); const data = manifest();
  assert.equal(validateManifest(data, root).pages, 1);
  writeFileSync(join(root, 'pages/New.svelte'), '');
  assert.throws(() => validateManifest(data, root), /Unlisted page/);
  data.pages.push({ source: 'pages/New.svelte', exemption: 'Server-rendered detail fixture pending' });
  assert.equal(validateManifest(data, root).exemptPages, 1);
  data.pages[1].exemption = '';
  assert.throws(() => validateManifest(data, root), /explicit exemption/);
});
test('new dynamic view also needs a scenario, even when no route module was added', t => {
  const root = setup(t); const data = manifest();
  writeFileSync(join(root, 'navigation.ts'), 'export const views = [{ id: "home" }, { id: "new" }] as const;');
  data.registries = [{ source: 'navigation.ts', export: 'views', scenarios: { home: 'home' } }];
  assert.throws(() => validateManifest(data, root), /Unlisted view: views.new/);
});
test('normal gate rejects missing CI baseline; only candidate preparation permits it', t => {
  const root = setup(t); rmSync(join(root, 'snapshots/mobile/home.png'));
  assert.throws(() => validateManifest(manifest(), root), /Missing CI baseline/);
  assert.doesNotThrow(() => validateManifest(manifest(), root, { allowMissingBaselines: true }));
});
test('skipped or removed tests and raw screenshot capture cannot claim visual coverage', () => {
  const record = { spec: 'home.spec.mjs', title: 'home renders', project: 'mobile', status: 'passed', steps: [] };
  assert.throws(() => validateExecution(manifest(), []), /did not pass/);
  assert.throws(() => validateExecution(manifest(), [record]), /No successful screenshot/);
  record.steps = [{ category: 'pw:api', title: 'page.screenshot', steps: [] }];
  assert.throws(() => validateExecution(manifest(), [record]), /No successful screenshot/);
  record.steps = [{ category: 'expect', title: 'Expect "toHaveScreenshot(home.png)"', steps: [] }];
  assert.doesNotThrow(() => validateExecution(manifest(), [record]));
  const two = manifest(); two.scenarios[0].evidence[0].snapshots.push('missing.png');
  assert.throws(() => validateExecution(two, [record]), /missing.png/);
  record.status = 'skipped';
  assert.throws(() => validateExecution(manifest(), [record]), /did not pass/);
});
test('candidate import rejects changed code, tampered bytes and paths outside CI baselines', () => {
  const bytes = Buffer.from('png');
  const candidate = { sha: 'abc', files: [{ path: 'snapshots/mobile/home.png', sha256: createHash('sha256').update(bytes).digest('hex') }] };
  assert.doesNotThrow(() => verifyCandidate(candidate, 'abc', ['snapshots'], () => bytes));
  assert.throws(() => verifyCandidate(candidate, 'def', ['snapshots'], () => bytes), /Stale candidate/);
  assert.throws(() => verifyCandidate(candidate, 'abc', ['snapshots'], () => Buffer.from('changed')), /checksum mismatch/);
  candidate.files[0].path = 'snapshots/../src/home.png';
  assert.throws(() => verifyCandidate(candidate, 'abc', ['snapshots'], () => bytes), /Unexpected candidate path/);
});

test('new conditional-router URL cannot hide behind an existing component', t => {
  const root = setup(t); const data = manifest();
  writeFileSync(join(root, 'Shell.svelte'), `path === "/"; path.startsWith("/new/")`);
  data.router = { source: 'Shell.svelte', paths: { '/': ['home'] } };
  assert.throws(() => validateManifest(data, root), /Unlisted router path: \/new\//);
});
