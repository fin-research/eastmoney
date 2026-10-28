// Publish the static report while preserving the active inference module byte for byte.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hash, reviewedModules, moduleHashes } from './report-patch.mjs';
import { schedulerEntry, schedulerModules } from './scheduler-patch.mjs';

const verify = process.argv[2] === '--verify';
const output = resolve(process.argv[verify ? 3 : 2] ?? '../outputs/research-report-20261003');
const api = 'https://api.cloudflare.com/client/v4/accounts/5cecc63c78acf8f5473f8745f4244448/workers/scripts/quant';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
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
const schedules = await json('/schedules');
const content = await get('/content/v2');
const entrypoint = content.headers.get('cf-entrypoint');
const entries = [...(await content.formData()).entries()];
const modules = Object.create(null);
for (const [name, file] of entries) {
  if (typeof file === 'string' || Object.hasOwn(modules, name)) throw new Error('Unexpected Worker module');
  modules[name] = Buffer.from(await file.arrayBuffer());
}
const reportModule = await readFile(new URL('./report.mjs', import.meta.url));
const layout = reviewedModules(entrypoint, modules, reportModule, {entry:schedulerEntry,modules:await schedulerModules()});
const original = layout.production;
const activeModules = moduleHashes(modules);
if (verify) {
  const baseline = JSON.parse(await readFile(resolve(output, 'baseline.json'), 'utf8'));
  if (JSON.stringify(baseline.schedules) !== JSON.stringify(schedules) || baseline.deployment.id !== deployment.id || JSON.stringify(baseline.activeModules) !== JSON.stringify(activeModules) || JSON.stringify(baseline.settings) !== JSON.stringify(settings)) {
    throw new Error('Production changed since report packaging');
  }
  for (const [name, checksum] of Object.entries(baseline.runtimeModules)) {
    if (hash(await readFile(resolve(output, 'runtime', name))) !== checksum) throw new Error('Local module changed after packaging: ' + name);
  }
  if (hash(await readFile(resolve(output, 'public/README.md'))) !== baseline.reportSha256) throw new Error('Report asset changed after packaging');
  console.log(JSON.stringify({ baseline_verified: true, productionModuleSha256: hash(original), reportSha256: baseline.reportSha256 }));
  process.exit(0);
}
const config = JSON.parse((await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).replace(/,\s*([}\]])/g, '$1'));
if (JSON.stringify(schedules.schedules.map(s => s.cron).sort()) !== JSON.stringify([...config.triggers.crons].sort())) throw new Error('Production Cron differs from checked configuration');
const expected = [
  ['ARTIFACTS', 'r2_bucket', 'bucket_name', 'eastmoney'],
  ['DATA', 'service', 'service', 'eastmoney-data'],
  ['HYPERDRIVE', 'hyperdrive', 'id', config.hyperdrive[0].id],
  ['INFERENCE', 'workflow', 'workflow_name', 'quant-bond-inference-trial'],
  ['MODEL_POINTER', 'plain_text', 'text', config.vars.MODEL_POINTER],
];
if (settings.compatibility_date !== config.compatibility_date || JSON.stringify(settings.compatibility_flags) !== JSON.stringify(config.compatibility_flags) || settings.bindings.length !== expected.length + (layout.wrapped ? 1 : 0) || expected.some(([name, type, field, value]) => !settings.bindings.some(b => b.name === name && b.type === type && b[field] === value))) {
  throw new Error('Production compatibility or bindings changed');
}
if (layout.wrapped && !settings.bindings.some(b => b.name === 'ASSETS' && b.type === 'assets')) throw new Error('Report assets binding differs');
if (settings.bindings.find(b => b.name === 'DATA').entrypoint !== 'InternalData') throw new Error('Production calendar entrypoint differs');
await mkdir(output);
await mkdir(resolve(output, 'public'), { recursive: true });
await mkdir(resolve(output, 'runtime'), { recursive: true });
for (const [name, bytes] of Object.entries(layout.runtime)) {
  await writeFile(resolve(output, 'runtime', name), bytes);
}
const report = await readFile(new URL('../README.md', import.meta.url));
await writeFile(resolve(output, 'public/README.md'), report);
Object.assign(config, { main: 'runtime/entry.js', base_dir: './runtime', no_bundle: true, find_additional_modules: true, rules: [{ type: 'ESModule', globs: ['*.js', '*.mjs'] }], assets: { ...config.assets, directory: './public' } });
await writeFile(resolve(output, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
await writeFile(resolve(output, 'baseline.json'), JSON.stringify({ deployment, settings, schedules, entrypoint, activeModules, runtimeModules: moduleHashes(layout.runtime), productionModuleSha256: hash(original), reportSha256: hash(report), preparedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ output, deploymentId: deployment.id, productionModuleSha256: hash(original), reportSha256: hash(report) }));
