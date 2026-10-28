import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reviewedModules, moduleHashes } from '../report-patch.mjs';
const original = Buffer.from('export class BondInferenceWorkflow {} export default {fetch(){return new Response(null,{status:404})}}');
const report = await readFile(new URL('../report.mjs', import.meta.url));

test('first and repeat report packages preserve the same inference and runtime bytes', () => {
  const first = reviewedModules('cron-entry.js', {'cron-entry.js': original}, report);
  assert.equal(first.wrapped, false);
  assert.equal(first.runtime['production.js'], original);
  const second = reviewedModules('entry.js', first.runtime, report);
  assert.equal(second.wrapped, true);
  assert.deepEqual(moduleHashes(second.runtime), moduleHashes(first.runtime));
  assert.equal(second.production, original);
});

test('unknown layouts and altered wrappers are rejected before any output is written', () => {
  const first = reviewedModules('cron-entry.js', {'cron-entry.js': original}, report);
  for (const changed of [
    {...first.runtime, 'extra.js': original},
    {...first.runtime, 'entry.js': Buffer.from('export default {}')},
    {...first.runtime, 'research-service.js': Buffer.from('export default {}')},
    {...first.runtime, 'research-report.mjs': Buffer.from('export default {}')},
    {'unexpected.js': original},
  ]) assert.throws(() => reviewedModules('entry.js', changed, report));
});
