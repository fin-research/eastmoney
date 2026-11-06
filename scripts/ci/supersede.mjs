import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The newest PR run cancels the unfinished older ones. A cancelled run still posts a failed
// "Monorepo CI", and GitHub lets the newest check suite decide the PR status. Cancelling by
// run id keeps the failure in an older suite; a concurrency group cancels whichever run
// arrives last, which can be the newest suite.
export function olderRuns(runs, { runId, pr }) {
  return runs
    .filter(r => r.id < runId && r.status !== 'completed' && r.pull_requests?.some(p => p.number === pr))
    .map(r => r.id);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, PR_NUMBER: pr, HEAD_REF: branch } = process.env;
  const runs = JSON.parse(gh('api', `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(branch)}&per_page=50`, '--jq', '.workflow_runs'));
  for (const id of olderRuns(runs, { runId: Number(runId), pr: Number(pr) })) {
    try {
      gh('api', '-X', 'POST', `repos/${repo}/actions/runs/${id}/cancel`);
      console.log(`Cancelled older run ${id}.`);
    } catch (error) {
      console.log(`Run ${id} was not cancelled: ${error.message.split('\n')[0]}`);
    }
  }
}
