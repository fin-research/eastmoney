import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// One watcher per run. Progress stays inside gh instead of returning the same
// job list to the agent every few seconds. This never dispatches or reruns CI.
export function waitForRun({ repo, runId, sha, event, timeoutSeconds = 1200 }, execute = spawnSync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9]\d*$/.test(String(runId ?? ''))
    || !/^[a-f0-9]{40}$/.test(sha ?? '')
    || !['pull_request', 'merge_group', 'push', 'workflow_dispatch'].includes(event)
    || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) {
    throw new Error('Usage: node scripts/wait-ci.mjs <owner/repo> <run-id> <full-sha> <event> [timeout-seconds: 1..1800]');
  }
  const started = Date.now();
  const call = (args, timeout, quiet = false) => execute('gh', args, {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    stdio: ['ignore', quiet ? 'ignore' : 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
  });
  const read = () => {
    const response = call(['api', `repos/${repo}/actions/runs/${runId}`], 15_000);
    if (response.error || response.status !== 0) throw new Error('Cannot read CI run; check gh authentication/API availability. No automatic retry.');
    const run = JSON.parse(response.stdout);
    if (String(run.id) !== String(runId) || run.head_sha !== sha || run.event !== event
      || run.repository?.full_name?.toLowerCase() !== repo.toLowerCase()) {
      throw new Error('CI run does not match the requested repository, run ID, SHA and event.');
    }
    return run;
  };
  let run = read();
  const attempt = run.run_attempt;
  let watcher;
  if (run.status !== 'completed') {
    watcher = call(['run', 'watch', String(runId), '--repo', repo, '--compact', '--exit-status', '--interval', '30'],
      timeoutSeconds * 1000, true);
    run = read();
  }
  const changedAttempt = run.run_attempt !== attempt;
  const pending = run.status !== 'completed';
  const exitCode = changedAttempt ? 1 : pending ? 2 : run.conclusion === 'success' ? 0 : 1;
  return {
    exitCode, repo, runId: String(runId), sha, event, attempt: run.run_attempt,
    status: run.status, conclusion: run.conclusion, url: run.html_url,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    reason: changedAttempt ? 'Run attempt changed; inspect the new attempt separately.'
      : pending ? (watcher?.error?.code === 'ETIMEDOUT' ? 'Wait deadline reached; CI is still pending.' : 'Watcher stopped before CI completed.')
        : 'Run finished. Check repository acceptance requirements; candidate/admission success is not full acceptance.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [repo, runId, sha, event, seconds, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Too many arguments.');
    const result = waitForRun({ repo, runId, sha, event, timeoutSeconds: seconds === undefined ? 1200 : Number(seconds) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
