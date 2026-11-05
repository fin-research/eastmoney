import { previousTimingQuoteDay } from './timing-advice.mjs';

export const nowcastFeatureVersion = 'timing-advice-v2';
const codes = { CDB3: 'E1701708', G3: 'E1000174', G1: 'E1000172', G10: 'E1000180', AAA3: 'E1000413' };
const fundingCode = 'E1300004';
const sectorLags = [0, 1, 2, 3, 4], liquidLags = [0, 1, 2, 3], fundingLags = [0, 1];
const names = [
  ...sectorLags.map(l => `sector_l${l}`),
  ...Object.keys(codes).flatMap(n => liquidLags.map(l => `${n}_l${l}`)),
  ...fundingLags.map(l => `funding_l${l}`),
];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const ridge = (part, size) => [part?.mean, part?.std, part?.beta].every(x => Array.isArray(x) && x.length === size && x.every(finite))
  && part.std.every(x => x > 0) && finite(part.intercept);

export function validateNowcastModel(manifest, model) {
  if (manifest.feature_version !== nowcastFeatureVersion || model.kind !== 'catch_up_ridge'
    || JSON.stringify(model.columns) !== JSON.stringify(names)
    || !ridge(model.catch_up, names.length) || !ridge(model.wait_3, names.length)
    || !Array.isArray(model.residual_quantiles) || model.residual_quantiles.length !== 200
    || !model.residual_quantiles.every(finite) || !(model.threshold_bp > 0) || model.wait_quotes !== 3)
    throw new Error('Invalid timing nowcast model');
}

function observations(rows, code, source) {
  const seen = new Map();
  for (const row of rows) {
    if (row.field !== code) continue;
    if (!dateValid(row.observation_date) || row.observation_date > source
      || (row.published_date && (!dateValid(row.published_date) || row.published_date > source))) throw new Error('Future timing input');
    if (!finite(row.value) || row.value === 0) continue;
    if (seen.has(row.observation_date)) throw new Error('Duplicate funding quote');
    seen.set(row.observation_date, row.value * 100);
  }
  return seen;
}

/** Value of the last observation on or before each sector date. */
function fillForward(seen, dates) {
  const days = [...seen.keys()].sort();
  let cursor = -1;
  return dates.map(date => {
    while (cursor + 1 < days.length && days[cursor + 1] <= date) cursor++;
    return cursor < 0 ? NaN : seen.get(days[cursor]);
  });
}

export function nowcastFeatures(inputs, columns = names) {
  const date = inputs.as_of_date, source = inputs.required_source_date;
  if (!dateValid(date) || !dateValid(source) || source >= date) throw new Error('Timing inputs must precede decision date');
  const sector = new Map();
  for (const row of inputs.datasets.sector3) {
    if (!dateValid(row.observation_date) || row.observation_date > source) throw new Error('Future timing input');
    if (sector.has(row.observation_date)) throw new Error('Duplicate sector quote');
    if (finite(row.yield_pct) && row.yield_pct !== 0) sector.set(row.observation_date, row.yield_pct * 100);
  }
  const dates = [...sector.keys()].sort();
  if (dates.at(-1) !== source) throw new Error('Stale market quote');
  const changes = values => values.map((value, i) => i === 0 ? NaN : value - values[i - 1]);
  const columnsOut = {};
  const add = (name, lags, values) => {
    const change = changes(values);
    for (const lag of lags) columnsOut[`${name}_l${lag}`] = change[change.length - 1 - lag];
  };
  add('sector', sectorLags, dates.map(d => sector.get(d)));
  for (const [name, code] of Object.entries(codes)) {
    const seen = observations(inputs.datasets.funding, code, source);
    if ([...seen.keys()].sort().at(-1) !== source) throw new Error('Stale market quote');
    add(name, liquidLags, fillForward(seen, dates));
  }
  const funding = observations(inputs.datasets.funding, fundingCode, source);
  if ([...funding.keys()].sort().at(-1) !== source) throw new Error('Stale market quote');
  add('funding', fundingLags, fillForward(funding, dates));
  const vector = columns.map(name => columnsOut[name]);
  if (vector.length !== names.length || !vector.every(finite)) throw new Error('Incomplete timing history');
  return vector;
}

const predict = (part, vector) => vector.reduce((sum, x, i) => sum + (x - part.mean[i]) / part.std[i] * part.beta[i], part.intercept);
const action = (wait, threshold) => wait > threshold ? '尽快' : wait < -threshold ? '暂缓' : '等待';
const narratives = {
  暂缓: '预测此后3个报价日利率下行，建议暂缓发行。',
  尽快: '预测此后3个报价日利率上行，建议尽快发行。',
  等待: '预测此后3个报价日利率变动不大，建议等待。',
};

export function outcomeProbabilities(model, wait) {
  const n = model.residual_quantiles.length;
  const realised = model.residual_quantiles.map(q => wait + q);
  const defer = realised.filter(x => x < -model.threshold_bp).length;
  const issue = realised.filter(x => x > model.threshold_bp).length;
  return { defer: defer / n, wait: (n - defer - issue) / n, issue: issue / n };
}

export function inferNowcast(manifest, model, inputs) {
  validateNowcastModel(manifest, model);
  if (inputs.required_source_date !== previousTimingQuoteDay(inputs.as_of_date, manifest.calendar)) throw new Error('Wrong timing source date');
  const vector = nowcastFeatures(inputs, model.columns);
  const catchUp = predict(model.catch_up, vector), wait = predict(model.wait_3, vector);
  const decision = action(wait, model.threshold_bp);
  return {
    schema_version: nowcastFeatureVersion, run_id: crypto.randomUUID(), generated_at: new Date().toISOString(),
    as_of_date: inputs.as_of_date, market_source_date: inputs.required_source_date,
    model_version: manifest.model_version, scope: 'AAA证券公司债3Y', training_label_cutoff: manifest.training_label_cutoff,
    forecast: { catch_up_bp: catchUp, wait_bp: wait, wait_quotes: model.wait_quotes, threshold_bp: model.threshold_bp },
    probabilities: outcomeProbabilities(model, wait), decision: { action: decision }, validation: manifest.validation,
    base_conclusion: { verdict: decision, preferred_window: '', narrative: narratives[decision] },
    online_run: { model_version: manifest.model_version, feature_version: nowcastFeatureVersion,
      training_as_of: manifest.training_as_of, retrain_after: manifest.retrain_after },
  };
}
