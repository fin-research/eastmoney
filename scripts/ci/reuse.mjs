import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKFLOW_NAME = 'Eastmoney CI';

export function prNumber(ref = '') {
  return /\/pr-(\d+)-/.exec(ref)?.[1] ?? null;
}

// The newest PR run that was not superseded must have passed.
export function passedRun(runs) {
  const run = runs.find(r => r.name === WORKFLOW_NAME && r.conclusion !== 'cancelled');
  return run?.conclusion === 'success' ? run : null;
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function lookup(env) {
  if (env.GITHUB_EVENT_NAME !== 'merge_group') return 'not a merge group run';
  const pr = prNumber(env.MERGE_GROUP_HEAD_REF);
  if (!pr) return 'merge group ref has no PR number';
  const repo = env.GITHUB_REPOSITORY;
  const head = gh('api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha').trim();
  const runs = JSON.parse(gh('api', `repos/${repo}/actions/runs?head_sha=${head}&event=pull_request&per_page=30`, '--jq', '.workflow_runs'));
  const run = passedRun(runs);
  if (!run) return `PR #${pr} has no passed run for ${head}`;
  const dir = mkdtempSync(join(tmpdir(), 'ci-tree-'));
  gh('run', 'download', String(run.id), '--repo', repo, '--name', 'ci-tree', '--dir', dir);
  const record = JSON.parse(readFileSync(join(dir, 'tree.json'), 'utf8'));
  const queued = git('rev-parse', 'HEAD^{tree}');
  if (!record.plan || typeof record.plan !== 'object') return 'ci-tree artifact has no plan';
  if (record.tree !== queued) return `tree ${queued} differs from PR run ${run.id} tree ${record.tree}`;
  console.log(`Tree ${queued} already passed in PR #${pr} run ${run.id}.`);
  return { plan: record.plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = lookup(process.env); } catch (error) { result = `lookup failed: ${error.message}`; }
  if (typeof result === 'string') console.log(`Full CI required: ${result}`);
  if (process.env.GITHUB_OUTPUT) {
    const reused = typeof result === 'object';
    appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\ntested=${JSON.stringify(reused ? result.plan : {})}\n`);
  }
}
