import { pathToFileURL } from 'node:url';

export function checkGate(event, needs, affected = true) {
  if (!affected) return 'No Dashboard changes require acceptance.';
  if (!['pull_request', 'merge_group', 'workflow_dispatch'].includes(event)) throw new Error(`Unexpected CI event: ${event}`);
  for (const job of ['unit', 'build-visual']) {
    if (needs[job]?.result !== 'success') throw new Error(`${job} did not pass: ${needs[job]?.result ?? 'missing'}`);
  }
  return 'All full checks passed for this commit.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(checkGate(process.env.CI_EVENT, JSON.parse(process.env.CI_NEEDS ?? '{}'), process.env.CI_AFFECTED !== 'false'));
}
