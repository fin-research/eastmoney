import assert from 'node:assert/strict';
import test from 'node:test';
import { olderRuns } from './supersede.mjs';

const run = (id, status, pr = 7) => ({ id, status, pull_requests: [{ number: pr }] });

test('cancels only unfinished runs of the same PR with a lower id', () => {
  const runs = [run(30, 'in_progress'), run(20, 'in_progress'), run(10, 'queued'), run(9, 'completed'), run(8, 'in_progress', 8), { id: 5, status: 'in_progress' }];
  assert.deepEqual(olderRuns(runs, { runId: 20, pr: 7 }), [10]);
});

test('the newest run cancels nothing above itself', () => {
  assert.deepEqual(olderRuns([run(30, 'queued')], { runId: 20, pr: 7 }), []);
});
