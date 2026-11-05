import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inferNowcast, nowcastFeatures, outcomeProbabilities, validateNowcastModel } from '../timing-nowcast.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/timing-nowcast-parity.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
function close(a, b, path = '') {
  if (typeof a === 'number') return assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') return Object.entries(a).forEach(([k, v]) => close(v, b[k], `${path}/${k}`));
  assert.equal(b, a, path);
}

test('JS features and snapshot equal the Python snapshot', () => {
  close(fixture.features, nowcastFeatures(fixture.inputs, fixture.model.columns), 'features');
  close(fixture.snapshot, inferNowcast(fixture.manifest, fixture.model, fixture.inputs), 'snapshot');
});
test('action follows the fixed threshold and the probabilities sum to one', () => {
  for (const [shift, action] of [[-50, '暂缓'], [50, '尽快'], [0, '等待']]) {
    const model = clone(fixture.model);
    model.wait_3.intercept = shift;
    model.wait_3.beta = model.wait_3.beta.map(() => 0);
    const result = inferNowcast(fixture.manifest, model, fixture.inputs);
    assert.equal(result.decision.action, action);
    assert.equal(result.base_conclusion.verdict, action);
    const p = result.probabilities;
    assert.ok(Math.abs(p.defer + p.wait + p.issue - 1) < 1e-12);
  }
  const low = outcomeProbabilities(fixture.model, -3), high = outcomeProbabilities(fixture.model, 3);
  assert.ok(low.defer > high.defer && high.issue > low.issue);
});
test('rejects a stale quote, a stale liquid curve, a wrong source day and an altered model', () => {
  const stale = clone(fixture.inputs);
  stale.datasets.sector3.pop();
  assert.throws(() => inferNowcast(fixture.manifest, fixture.model, stale), /Stale/);
  const liquid = clone(fixture.inputs);
  liquid.datasets.funding = liquid.datasets.funding.filter(r => !(r.field === 'E1000174' && r.observation_date === fixture.inputs.required_source_date));
  assert.throws(() => inferNowcast(fixture.manifest, fixture.model, liquid), /Stale/);
  const wrong = clone(fixture.inputs);
  wrong.required_source_date = '2026-10-26';
  assert.throws(() => inferNowcast(fixture.manifest, fixture.model, wrong), /Wrong timing source date/);
  const model = clone(fixture.model);
  model.catch_up.std[0] = 0;
  assert.throws(() => validateNowcastModel(fixture.manifest, model), /Invalid/);
  const short = clone(fixture.inputs);
  short.datasets.sector3 = short.datasets.sector3.slice(-4);
  assert.throws(() => inferNowcast(fixture.manifest, fixture.model, short), /Incomplete/);
});
test('a future observation is refused', () => {
  const future = clone(fixture.inputs);
  future.datasets.funding.push({ field: 'E1701708', observation_date: fixture.inputs.as_of_date, published_date: fixture.inputs.as_of_date, value: 2 });
  assert.throws(() => inferNowcast(fixture.manifest, fixture.model, future), /Future/);
});
test('the middle probability is exact when no residual falls inside the band', () => {
  const model = { residual_quantiles: Array.from({ length: 200 }, (_, i) => (i < 14 ? -7 : 7)), threshold_bp: 0.5 };
  const p = outcomeProbabilities(model, 0);
  assert.equal(p.wait, 0);
  assert.ok(Math.abs(p.defer + p.wait + p.issue - 1) < 1e-12);
});
