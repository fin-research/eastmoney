// Preserve the current production model when the local research source differs.
// This prepares an ignored artifact; deploy only after dry-run and baseline revalidation.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const output = resolve(process.argv[2] ?? '../outputs/trading-day-cron-20261003');
const api = 'https://api.cloudflare.com/client/v4/accounts/5cecc63c78acf8f5473f8745f4244448/workers/scripts/quant';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function get(path) {
  const response = await fetch(api + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Production baseline HTTP ${response.status}`);
  return response;
}
async function json(path) {
  const body = await (await get(path)).json();
  if (!body.success) throw new Error('Production baseline API failed');
  return body.result;
}
const deployment = (await json('/deployments')).deployments[0];
const settings = await json('/settings');
const form = await (await get('/content/v2')).formData();
const entries = [...form.entries()];
if (entries.length !== 1 || entries[0][0] !== 'worker.js' || typeof entries[0][1] === 'string') {
  throw new Error('Expected one production ES module; inspect a changed module layout manually');
}
const original = new Uint8Array(await entries[0][1].arrayBuffer());
const source = new TextDecoder().decode(original);
if (!source.includes('BondInferenceWorkflow') || !source.includes('worker_default as default')) throw new Error('Unexpected production exports');
const config = JSON.parse((await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).replace(/,\s*([}\]])/g, '$1'));
if (settings.compatibility_date !== config.compatibility_date || JSON.stringify(settings.compatibility_flags) !== JSON.stringify(config.compatibility_flags)) {
  throw new Error('Production compatibility settings changed');
}
const expected = [
  ['ARTIFACTS', 'r2_bucket', 'bucket_name', 'eastmoney'],
  ['HYPERDRIVE', 'hyperdrive', 'id', config.hyperdrive[0].id],
  ['INFERENCE', 'workflow', 'workflow_name', 'quant-bond-inference-trial'],
  ['MODEL_POINTER', 'plain_text', 'text', config.vars.MODEL_POINTER],
];
if (settings.bindings.length !== expected.length || expected.some(([name, type, field, value]) =>
  !settings.bindings.some(binding => binding.name === name && binding.type === type && binding[field] === value))) {
  throw new Error('Production bindings changed; inspect before packaging');
}
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'production.js'), original);
await writeFile(resolve(output, 'scheduled.js'), stripTypeScriptTypes(await readFile(new URL('./scheduled.ts', import.meta.url), 'utf8')));
await writeFile(resolve(output, 'entry.js'), `export { BondInferenceWorkflow } from './production.js';\nimport original from './production.js';\nimport { startScheduledInference } from './scheduled.js';\nexport default { ...original, async scheduled(event, env) { await startScheduledInference(env,event.scheduledTime); } };\n`);
Object.assign(config, { main: 'entry.js', no_bundle: true, find_additional_modules: true, rules: [{ type: 'ESModule', globs: ['*.js'] }] });
await writeFile(resolve(output, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
const evidence = { deployment, settings, productionModuleSha256: hash(original), preparedAt: new Date().toISOString() };
await writeFile(resolve(output, 'baseline.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ output, deploymentId: deployment.id, versions: deployment.versions, productionModuleSha256: evidence.productionModuleSha256 }));
