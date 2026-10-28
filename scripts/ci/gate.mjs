import { pathToFileURL } from 'node:url';

export function verify(plan, needs) {
  for (const project of ['gateway', 'dashboard', 'data', 'choice', 'messenger', 'ingest', 'quant']) {
    if (!['true', 'false'].includes(plan[project])) throw new Error(`Invalid change plan for ${project}.`);
  }
  if (needs.changes?.result !== 'success') throw new Error('Change analysis did not pass.');
  for (const project of ['gateway', 'data', 'messenger', 'ingest', 'quant', 'choice']) {
    const expected = plan[project] === 'true' ? 'success' : 'skipped';
    if (needs[project]?.result !== expected) throw new Error(`${project}: expected ${expected}, received ${needs[project]?.result}`);
  }
  if (needs.dashboard?.result !== 'success') throw new Error('Dashboard gate did not pass.');
  const integration = ['gateway', 'dashboard', 'data'].some(p => plan[p] === 'true');
  if (needs.integration?.result !== (integration ? 'success' : 'skipped')) throw new Error('Service integration did not pass.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verify(JSON.parse(process.env.CI_PLAN), JSON.parse(process.env.CI_NEEDS));
  console.log('All affected project checks passed.');
}
