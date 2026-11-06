import pg from 'pg';
import queries from './coupon-queries.json' with { type: 'json' };
import { allEdbCodes, bondTypes, couponFeatureVersion, curveCode, factorCodes, inferCoupon, issuerName } from './coupon-forecast.mjs';
import { previousTimingQuoteDay } from './timing-advice.mjs';
import { publishArchivedResult } from './publication.mjs';

const recentQuoteDays = 45;
const pointerKey = 'quant-trial/models/current-coupon.json';

/** Same reads as data/coupon_inputs.py: one read-only snapshot, strictly before the decision date. */
export async function loadCouponInputs(client, date, calendar) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const q = (name, args) => client.query(queries[name], args).then(r => r.rows);
  const days = (await q('curve_days', [curveCode, date])).map(r => r.observation_date);
  const recent = days.slice(-recentQuoteDays);
  const events = await q('issuer_events', [issuerName, bondTypes, date]);
  const eventDays = new Set();
  for (const e of events) {
    let found = null;
    for (let i = days.length - 1; i >= 0; i--) if (days[i] < e.tender_date) { found = days[i]; break; }
    if (found && !recent.includes(found)) eventDays.add(found);
  }
  const inputs = {
    schema_version: 1, as_of_date: date, required_source_date: previousTimingQuoteDay(date, calendar), issuer: issuerName,
    datasets: {
      edb: await q('edb', [allEdbCodes, date, date]),
      quant_input: await q('quant_input', [factorCodes.primary, date, date]),
      curve_days: days.map(d => ({ observation_date: d })),
      curve: await q('curve_at', [curveCode, recent]),
      event_curves: eventDays.size ? await q('curve_at', [curveCode, [...eventDays].sort()]) : [],
      issuer_events: events,
      issuer_bonds: await q('issuer_bonds', [recent, issuerName, bondTypes]),
    },
  };
  await client.query('COMMIT');
  return inputs;
}

/** Runs after the timing forecast is published. A failure here never fails the timing result. */
export async function runCouponWorkflow(env, step, event, timing, io) {
  const date = timing.as_of_date;
  const workflowId = `${event.instanceId.slice(0, 90)}-coupon`;
  const prefix = `quant-trial/runs/${date}/${workflowId}`;
  const manifest = await step.do('pin-coupon-model', async () => {
    if (!(await env.ARTIFACTS.head(pointerKey))) return null;
    const pointer = await io.readJson(env.ARTIFACTS, pointerKey);
    if (!/^[a-f0-9]{20}$/.test(pointer.model_version)) throw new Error('Invalid coupon pointer');
    const value = await io.readJson(env.ARTIFACTS, `quant-trial/models/${pointer.model_version}/manifest.json`, 256 * 1024, pointer.manifest_sha256);
    if (value.feature_version !== couponFeatureVersion || value.model_version !== pointer.model_version) throw new Error('Invalid coupon bundle');
    return date < value.training_as_of || date > value.retrain_after ? null : value;
  });
  if (!manifest) return null;
  const active = await step.do('check-coupon-eligibility', async () => {
    const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
      await client.connect();
      const found = await client.query('SELECT status FROM financing_model.model_eligibility WHERE model_version=$1', [manifest.model_version]);
      return found.rows[0]?.status === 'active';
    } finally { await client.end(); }
  });
  if (!active) return null;
  const model = await step.do('load-coupon-forecast-model', () => io.modelFile(env.ARTIFACTS, manifest, 'main'));
  await step.do('freeze-coupon-inputs', async () => {
    if (await env.ARTIFACTS.head(`${prefix}/inputs.json`)) return;
    const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 15000, query_timeout: 60000 });
    try { await client.connect(); await io.putJson(env.ARTIFACTS, `${prefix}/inputs.json`, await loadCouponInputs(client, date, manifest.calendar)); }
    finally { await client.end(); }
  });
  const key = await step.do('predict-coupon-forecast', { retries: { limit: 0, delay: '1 second' } }, async () => {
    const inputs = await io.readJson(env.ARTIFACTS, `${prefix}/inputs.json`, 8 * 1024 * 1024);
    const result = inferCoupon(manifest, model, inputs, { catch_up_bp: timing.forecast.catch_up_bp, wait_bp: timing.forecast.wait_bp, action: timing.decision.action });
    Object.assign(result.online_run, { runtime: 'cloudflare-workflow', input_prefix: prefix, workflow_id: workflowId });
    return io.putJson(env.ARTIFACTS, `${prefix}/result.json`, result);
  });
  return step.do('publish-coupon-result', () => publishArchivedResult(env, key, pg.Client));
}
