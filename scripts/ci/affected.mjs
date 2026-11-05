import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const projects = ['gateway', 'dashboard', 'data', 'messenger', 'ingest', 'quant'];

export function declared(labels) {
  const scope = new Set();
  const scoped = labels.filter(l => l.startsWith('ci:'));
  for (const label of scoped) {
    const name = label.slice(3);
    if (name === 'none') continue;
    if (name === 'all') projects.forEach(p => scope.add(p));
    else if (projects.includes(name)) scope.add(name);
    else throw new Error(`Unknown CI scope label: ${label}`);
  }
  return scoped.length ? scope : null;
}

export function affected(paths, all = false, scope = null) {
  const selected = new Set(all ? projects : []);
  for (const path of paths) {
    const owner = path.split('/')[0];
    if (projects.includes(owner)) selected.add(owner);
    else if (!path.startsWith('docs/') && !['README.md'].includes(path)) projects.forEach(p => selected.add(p));
    if (/^(data\/src\/|data\/wrangler)/.test(path)) {
      ['gateway', 'dashboard', 'ingest', 'quant'].forEach(p => selected.add(p));
    }
    if (/^gateway\/(src|wrangler)/.test(path)) ['dashboard', 'data'].forEach(p => selected.add(p));
    if (/^dashboard\/(src\/data-contracts|src\/lib\/(?:permissions|route-permissions)\.ts|worker|wrangler)/.test(path)) selected.add('gateway');
    if (/^messenger\/(src|wrangler)/.test(path)) ['dashboard', 'data', 'ingest', 'quant'].forEach(p => selected.add(p));
    if (/^quant\/(online|model|data)/.test(path)) selected.add('dashboard');
    if (/^(dashboard|ingest)\/migrations\//.test(path)) ['dashboard', 'ingest'].forEach(p => selected.add(p));
    if (/^dashboard\/financing-model-migrations\//.test(path)) selected.add('quant');
    if (/^docs\/(AUTH|ARCHITECTURE|DATABASE|AI|TESTING)\.md$/.test(path)) projects.forEach(p => selected.add(p));
  }
  const final = scope && !all ? scope : selected;
  return Object.fromEntries(projects.map(p => [p, final.has(p)]));
}

// Reuse only when the PR run tested every project this queue run needs.
export function covered(full, tested) {
  return projects.every(p => !full[p] || tested?.[p] === 'true');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.CI_BASE_SHA;
  const all = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || !base;
  const paths = all ? [] : execFileSync('git', ['diff', '--name-only', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const labels = (process.env.CI_LABELS ?? '').split(/[\n,]/).map(l => l.trim()).filter(Boolean);
  const full = affected(paths, all, declared(labels));
  const reused = process.env.CI_REUSED === 'true' && covered(full, JSON.parse(process.env.CI_TESTED || '{}'));
  if (process.env.CI_REUSED === 'true' && !reused) console.log('PR run did not test every needed project; running full CI.');
  const plan = reused ? Object.fromEntries(projects.map(p => [p, false])) : full;
  if (process.env.GITHUB_OUTPUT) {
    for (const [name, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
  }
  console.log(JSON.stringify(plan));
}
