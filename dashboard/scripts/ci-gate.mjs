import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkGate(event, needs, rules = [], affected = true) {
  if (!affected) return 'No Dashboard changes require acceptance.';
  if (event === 'pull_request') {
    // Admission is not test acceptance. Only the protected queue may merge,
    // and it must run this same check on the integrated commit.
    const queue = rules.some(rule => rule.type === 'merge_queue');
    const required = rules.some(rule => rule.type === 'required_status_checks'
      && rule.parameters?.required_status_checks?.some(check =>
        check.context === 'Monorepo CI' && check.integration_id === 15368));
    if (!queue || !required) throw new Error('PR admission requires an enforced merge queue and GitHub Actions Monorepo CI.');
    return 'PR admitted; full acceptance runs only in the merge queue.';
  }
  if (!['merge_group', 'workflow_dispatch'].includes(event)) throw new Error(`Unexpected CI event: ${event}`);
  for (const job of ['unit', 'build-visual']) {
    if (needs[job]?.result !== 'success') throw new Error(`${job} did not pass: ${needs[job]?.result ?? 'missing'}`);
  }
  return 'All full checks passed for this commit.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.CI_EVENT;
  const rules = event === 'pull_request'
    ? JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/dashboard-rules.json`, 'utf8')) : [];
  console.log(checkGate(event, JSON.parse(process.env.CI_NEEDS ?? '{}'), rules, process.env.CI_AFFECTED !== 'false'));
}
