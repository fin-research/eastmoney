import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(new URL('../visual-coverage.json', import.meta.url), 'utf8'));
const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const selected = new Set();
let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--page' && args[i + 1]) selected.add(args[++i]);
  else throw new Error(`Unknown option: ${args[i]}`);
}

function changedFiles() {
  const tracked = execFileSync('git', ['diff', '--name-only', '-z', 'origin/main', '--'], { cwd: root });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root });
  return [...new Set(Buffer.concat([tracked, untracked]).toString().split('\0').filter(Boolean))];
}

const files = !all && !selected.size ? changedFiles() : [];
if (!all && !selected.size) {
  const pageSources = new Set(manifest.pages.map(page => page.source));
  const unknownUi = files.filter(file => (file.startsWith('src/') || file.startsWith('tests/visual/') || file === 'visual-coverage.json') && !pageSources.has(file));
  if (unknownUi.length) throw new Error(`Shared UI files need explicit --page <source-or-scenario> or --all:\n${unknownUi.join('\n')}`);
  for (const file of files) if (pageSources.has(file)) selected.add(file);
}

const ids = new Set();
if (all) for (const scenario of manifest.scenarios) ids.add(scenario.id);
for (const page of manifest.pages) {
  if (selected.has(page.source)) for (const id of page.scenarios ?? []) ids.add(id);
}
for (const value of selected) {
  if (manifest.scenarios.some(scenario => scenario.id === value)) ids.add(value);
  else if (!manifest.pages.some(page => page.source === value)) throw new Error(`Unknown page or scenario: ${value}`);
}
const scenarios = manifest.scenarios.filter(scenario => ids.has(scenario.id));
if (!scenarios.length) {
  console.log('No changed page with a visual scenario.');
  process.exit(0);
}

const runRoot = resolve(root, '.local-visual', new Date().toISOString().replaceAll(':', '-'));
const capture = resolve(runRoot, 'capture');
const review = resolve(runRoot, 'review');
mkdirSync(capture, { recursive: true });
mkdirSync(review, { recursive: true });
const run = (command, commandArgs, env = process.env) => {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed (${result.status ?? result.error})`);
};
run(process.execPath, ['--max-old-space-size=4096', 'node_modules/vite/bin/vite.js', 'build']);
run('pnpm', ['build:visual']);

const tasks = new Map();
for (const scenario of scenarios) for (const evidence of scenario.evidence ?? []) {
  for (const project of evidence.projects ?? []) {
    const key = JSON.stringify([evidence.spec, project]);
    if (!tasks.has(key)) tasks.set(key, { spec: evidence.spec, project, tests: new Set() });
    tasks.get(key).tests.add(evidence.test);
  }
}
const captureEnv = { ...process.env, LOCAL_VISUAL_CAPTURE_DIR: capture };
if (all) run('pnpm', ['exec', 'playwright', 'test', '--update-snapshots=all'], { ...captureEnv, VISUAL_COVERAGE_GATE: '1' });
else for (const { spec, project, tests } of tasks.values()) {
  const grep = [...tests].map(test => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  run('pnpm', ['exec', 'playwright', 'test', spec, '--project', project, '--grep', grep, '--update-snapshots=all'], captureEnv);
}

let count = 0;
for (const scenario of scenarios) for (const evidence of scenario.evidence ?? []) {
  for (const project of evidence.projects ?? []) for (const snapshot of evidence.snapshots ?? []) {
    const source = resolve(capture, project, snapshot);
    if (!existsSync(source)) throw new Error(`Expected local screenshot missing: ${source}`);
    const destination = resolve(review, scenario.id, project, snapshot);
    mkdirSync(resolve(review, scenario.id, project), { recursive: true });
    cpSync(source, destination);
    count++;
  }
}
console.log(`Captured ${count} changed-page screenshots for ${[...ids].join(', ')}: ${review}`);
console.log('Local screenshots are review evidence; merge-queue CI compares linux-ci baselines.');
