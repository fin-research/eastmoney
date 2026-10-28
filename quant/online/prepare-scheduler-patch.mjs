// Preserve the active model, report modules and deployed assets; add only scheduling.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { hash, moduleHashes } from './report-patch.mjs';
import { schedulerEntry, schedulerModules, reviewSchedulerBaseline } from './scheduler-patch.mjs';

const mode = process.argv[2]?.startsWith('--') ? process.argv[2] : 'prepare';
if (!['prepare', '--verify', '--apply'].includes(mode)) throw new Error('Use output-directory, --verify output-directory or --apply output-directory');
const directory = process.argv[mode === 'prepare' ? 2 : 3];
if (!directory) throw new Error('A fresh output directory is required');
const output = resolve(directory);
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
const [deployments, settings, schedules, content] = await Promise.all([json('/deployments'), json('/settings'), json('/schedules'), get('/content/v2')]);
const deployment = deployments.deployments[0];
if (deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100) throw new Error('Production must have one active version');
const modules = Object.create(null);
for (const [name, file] of (await content.formData()).entries()) {
  if (typeof file === 'string' || Object.hasOwn(modules, name)) throw new Error('Unexpected module');
  modules[name] = Buffer.from(await file.arrayBuffer());
}
const added = await schedulerModules();
reviewSchedulerBaseline(content.headers.get('cf-entrypoint'), modules, await readFile(new URL('./report.mjs', import.meta.url)), added);
const config = JSON.parse((await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).replace(/,\s*([}\]])/g, '$1'));
const expected = [
  ['ARTIFACTS','r2_bucket','bucket_name','eastmoney'], ['ASSETS','assets',null,null],
  ['DATA','service','service','eastmoney-data'], ['HYPERDRIVE','hyperdrive','id',config.hyperdrive[0].id],
  ['INFERENCE','workflow','workflow_name','quant-bond-inference-trial'], ['MODEL_POINTER','plain_text','text',config.vars.MODEL_POINTER],
];
if (settings.compatibility_date !== config.compatibility_date || JSON.stringify(settings.compatibility_flags) !== JSON.stringify(config.compatibility_flags)
  || settings.bindings.length !== expected.length || expected.some(([name,type,field,value]) => !settings.bindings.some(b => b.name === name && b.type === type && (!field || b[field] === value)))
  || settings.bindings.find(b => b.name === 'DATA').entrypoint !== 'InternalData') throw new Error('Production bindings or compatibility changed');
const activeModules = moduleHashes(modules);
if (mode !== 'prepare') {
  const baseline = JSON.parse(await readFile(resolve(output,'baseline.json'),'utf8'));
  if (baseline.deployment.id !== deployment.id || JSON.stringify(baseline.settings) !== JSON.stringify(settings)
    || JSON.stringify(baseline.schedules) !== JSON.stringify(schedules) || JSON.stringify(baseline.activeModules) !== JSON.stringify(activeModules)) throw new Error('Production changed since packaging');
  for (const [name, checksum] of Object.entries(baseline.runtimeModules)) {
    if (hash(await readFile(resolve(output,'runtime',name))) !== checksum) throw new Error(`Packaged module changed: ${name}`);
    if (hash(await readFile(resolve(output,'dry',name))) !== checksum) throw new Error(`Dry-run module differs: ${name}`);
  }
  const metadata = JSON.parse(await readFile(resolve(output,'metadata.json'),'utf8'));
  if (JSON.stringify(metadata) !== JSON.stringify(baseline.metadata)) throw new Error('Upload metadata changed');
  if (mode === '--verify') { console.log(JSON.stringify({ baseline_verified:true, productionModuleSha256:activeModules['production.js'] })); process.exit(0); }
  const form = new FormData();
  form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
  for (const name of Object.keys(baseline.runtimeModules)) form.set(name,new Blob([await readFile(resolve(output,'runtime',name))],{type:'application/javascript+module'}),name);
  const response = await fetch(api,{method:'PUT',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(60_000)});
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Scheduler upload failed: HTTP ${response.status}: ${JSON.stringify(result.errors)}`);
  console.log(JSON.stringify({ applied:true, version:result.result.version_id, productionModuleSha256:activeModules['production.js'] }));
  process.exit(0);
}
await mkdir(dirname(output), {recursive:true});
await mkdir(output);
await mkdir(resolve(output,'runtime'));
const runtime = {...modules,...added,'entry.js':Buffer.from(schedulerEntry)};
for (const [name,bytes] of Object.entries(runtime)) await writeFile(resolve(output,'runtime',name),bytes);
const metadata = {main_module:'entry.js',keep_assets:true,bindings:settings.bindings,compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags,
  observability:settings.observability,placement:settings.placement,logpush:settings.logpush,tail_consumers:settings.tail_consumers};
if (settings.limits) metadata.limits=settings.limits;
await writeFile(resolve(output,'metadata.json'),JSON.stringify(metadata,null,2));
// Packaging validation only. Production upload reuses deployed assets with keep_assets.
const dryConfig={...config,main:'runtime/entry.js',base_dir:'./runtime',no_bundle:true,find_additional_modules:true,rules:[{type:'ESModule',globs:['*.js','*.mjs']}]};
delete dryConfig.assets;
await writeFile(resolve(output,'wrangler.jsonc'),JSON.stringify(dryConfig,null,2));
await writeFile(resolve(output,'baseline.json'),JSON.stringify({deployment,settings,schedules,activeModules,runtimeModules:moduleHashes(runtime),metadata,preparedAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({output,deploymentId:deployment.id,productionModuleSha256:activeModules['production.js']}));
