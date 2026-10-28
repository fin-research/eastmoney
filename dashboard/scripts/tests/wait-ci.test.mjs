import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForRun } from '../wait-ci.mjs';

const input = { repo: 'owner/repo', runId: '123', sha: 'a'.repeat(40), event: 'merge_group' };
const run = (changes = {}) => ({ id: 123, repository: { full_name: 'owner/repo' }, head_sha: input.sha,
  event: 'merge_group', run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/123', ...changes });
function fake(responses) {
  const calls = [];
  return { calls, execute: (command, args, options) => {
    calls.push({ command, args, options });
    assert.ok(responses.length, 'unexpected repeated API call or watcher');
    return responses.shift();
  } };
}
const response = value => ({ status: 0, stdout: JSON.stringify(value) });

test('completed run returns evidence without starting another watcher', () => {
  const io = fake([response(run())]);
  assert.equal(waitForRun(input, io.execute).exitCode, 0);
  assert.equal(io.calls.length, 1);
});
test('pending run starts one bounded quiet watcher then reads terminal evidence once', () => {
  const io = fake([response(run({ status: 'in_progress', conclusion: null })), { status: 0 }, response(run())]);
  assert.equal(waitForRun(input, io.execute).exitCode, 0);
  assert.equal(io.calls.length, 3);
  assert.deepEqual(io.calls[1].args, ['run', 'watch', '123', '--repo', 'owner/repo', '--compact', '--exit-status', '--interval', '30']);
  assert.equal(io.calls[1].options.timeout, 1_200_000);
  assert.equal(io.calls[1].options.stdio[1], 'ignore');
});
test('deadline remains pending and never starts a second watcher or reruns CI', () => {
  const pending = run({ status: 'queued', conclusion: null });
  const io = fake([response(pending), { error: { code: 'ETIMEDOUT' }, status: null }, response(pending)]);
  const result = waitForRun(input, io.execute);
  assert.equal(result.exitCode, 2);
  assert.match(result.reason, /deadline/);
  assert.equal(io.calls.length, 3);
});
test('failed, cancelled and skipped runs cannot count as passed', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    assert.equal(waitForRun(input, fake([response(run({ conclusion }))]).execute).exitCode, 1);
  }
});
test('stale SHA, wrong event or repository and changed attempts cannot count as evidence', () => {
  for (const changes of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { repository: { full_name: 'other/repo' } }]) {
    assert.throws(() => waitForRun(input, fake([response(run(changes))]).execute), /does not match/);
  }
  const io = fake([response(run({ status: 'in_progress' })), { status: 0 }, response(run({ run_attempt: 2 }))]);
  assert.equal(waitForRun(input, io.execute).exitCode, 1);
});
test('API failure returns immediately without repeatedly querying or launching a watcher', () => {
  const io = fake([{ status: 1, stderr: 'API unavailable' }]);
  assert.throws(() => waitForRun(input, io.execute), /No automatic retry/);
  assert.equal(io.calls.length, 1);
});
