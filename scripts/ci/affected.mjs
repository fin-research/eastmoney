import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const projects = ['gateway', 'dashboard', 'data', 'choice', 'messenger', 'ingest', 'quant'];

export function affected(paths, all = false) {
  const selected = new Set(all ? projects : []);
  for (const path of paths) {
    const owner = path.split('/')[0];
    if (projects.includes(owner)) selected.add(owner);
    else if (!path.startsWith('docs/') && !['README.md'].includes(path)) projects.forEach(p => selected.add(p));
    if (/^(data\/src\/|data\/wrangler)/.test(path)) {
      ['gateway', 'dashboard', 'ingest', 'quant'].forEach(p => selected.add(p));
    }
    if (/^gateway\/(src|wrangler)/.test(path)) ['dashboard', 'data'].forEach(p => selected.add(p));
    if (/^dashboard\/(src\/data-contracts|src\/lib\/gateway-contracts|worker|wrangler)/.test(path)) selected.add('gateway');
    if (/^messenger\/(src|wrangler)/.test(path)) ['dashboard', 'data', 'ingest', 'quant'].forEach(p => selected.add(p));
    if (/^quant\/(online|model|data)/.test(path)) selected.add('dashboard');
    if (owner === 'choice') selected.add('data');
    if (/^(dashboard|ingest)\/migrations\//.test(path)) ['dashboard', 'ingest'].forEach(p => selected.add(p));
    if (/^dashboard\/financing-model-migrations\//.test(path)) selected.add('quant');
    if (/^docs\/(AUTH|ARCHITECTURE|DATABASE|AI|TESTING)\.md$/.test(path)) projects.forEach(p => selected.add(p));
  }
  return Object.fromEntries(projects.map(p => [p, selected.has(p)]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.CI_BASE_SHA;
  const all = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || !base;
  const paths = all ? [] : execFileSync('git', ['diff', '--name-only', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const plan = affected(paths, all);
  if (process.env.GITHUB_OUTPUT) for (const [name, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(JSON.stringify(plan));
}
