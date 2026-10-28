// Change only the current production module's lossless curve-input transport.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hash,moduleHashes} from './report-patch.mjs';
import {patchCurveGridRuntime} from './curve-grid-patch.mjs';
const mode=process.argv[2]?.startsWith('--')?process.argv[2]:'prepare';
const output=resolve(process.argv[mode==='prepare'?2:3]??'');
if(!['prepare','--verify','--apply'].includes(mode)||!process.argv[mode==='prepare'?2:3])throw Error('Use output-directory, --verify output-directory or --apply output-directory');
const endpoint='https://api.cloudflare.com/client/v4/accounts/5cecc63c78acf8f5473f8745f4244448/workers/scripts/quant';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('Cloudflare token unavailable');
async function get(path){const response=await fetch(endpoint+path,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`Production baseline HTTP${response.status}`);return response;}
async function json(path){const body=await(await get(path)).json();if(!body.success)throw Error('Production baseline failed');return body.result;}
const [deployments,settings,schedules,content]=await Promise.all([json('/deployments'),json('/settings'),json('/schedules'),get('/content/v2')]);
const deployment=deployments.deployments[0];
if(deployment.versions.length!==1||deployment.versions[0].percentage!==100)throw Error('Expected one active production version');
const modules=Object.create(null);
for(const[name,file]of(await content.formData()).entries()){if(typeof file==='string'||Object.hasOwn(modules,name))throw Error('Unexpected module');modules[name]=Buffer.from(await file.arrayBuffer());}
const names=['entry.js','production.js','research-report.mjs','research-service.js','scheduled-tasks.js','scheduled.js','scheduler-service.js'].sort();
if(content.headers.get('cf-entrypoint')!=='entry.js'||JSON.stringify(Object.keys(modules).sort())!==JSON.stringify(names))throw Error('Production module layout changed');
const activeModules=moduleHashes(modules);
if(mode!=='prepare'){
 const baseline=JSON.parse(await readFile(resolve(output,'baseline.json'),'utf8'));
 if(deployment.id!==baseline.deployment.id||JSON.stringify(settings)!==JSON.stringify(baseline.settings)||JSON.stringify(schedules)!==JSON.stringify(baseline.schedules)||JSON.stringify(activeModules)!==JSON.stringify(baseline.activeModules))throw Error('Production changed after packaging');
 for(const[name,sha]of Object.entries(baseline.runtimeModules))for(const folder of ['runtime','dry'])if(hash(await readFile(resolve(output,folder,name)))!==sha)throw Error('Packaged module changed');
 const metadata=JSON.parse(await readFile(resolve(output,'metadata.json'),'utf8'));
 if(JSON.stringify(metadata)!==JSON.stringify(baseline.metadata))throw Error('Upload metadata changed');
 if(mode==='--verify'){console.log(JSON.stringify({baseline_verified:true,unchanged_modules:6}));process.exit(0);}
 const form=new FormData();form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
 for(const name of names)form.set(name,new Blob([await readFile(resolve(output,'runtime',name))],{type:'application/javascript+module'}),name);
 const response=await fetch(endpoint,{method:'PUT',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(60000)});
 const body=await response.json();
 if(!response.ok||!body.success)throw Error(`Transport upload failed HTTP${response.status}`);
 await writeFile(resolve(output,'application.json'),JSON.stringify({applied_at:new Date().toISOString(),version:body.result.version_id,previous:baseline.activeModules,uploaded:baseline.runtimeModules},null,2));
 console.log(JSON.stringify({applied:true,version:body.result.version_id}));process.exit(0);
}
const runtime={...modules,'production.js':Buffer.from(patchCurveGridRuntime(modules['production.js'].toString()))};
const metadata={main_module:'entry.js',keep_assets:true,bindings:settings.bindings,compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags,observability:settings.observability,placement:settings.placement,logpush:settings.logpush,tail_consumers:settings.tail_consumers};
if(settings.limits)metadata.limits=settings.limits;
await mkdir(output);await mkdir(resolve(output,'runtime'));
for(const[name,bytes]of Object.entries(runtime))await writeFile(resolve(output,'runtime',name),bytes);
const config=JSON.parse((await readFile(new URL('./wrangler.jsonc',import.meta.url),'utf8')).replace(/,\s*([}\]])/g,'$1'));
Object.assign(config,{main:'runtime/entry.js',base_dir:'./runtime',no_bundle:true,find_additional_modules:true,rules:[{type:'ESModule',globs:['*.js','*.mjs']}]});delete config.assets;
await writeFile(resolve(output,'wrangler.jsonc'),JSON.stringify(config,null,2));
await writeFile(resolve(output,'metadata.json'),JSON.stringify(metadata,null,2));
await writeFile(resolve(output,'baseline.json'),JSON.stringify({prepared_at:new Date().toISOString(),deployment,settings,schedules,activeModules,runtimeModules:moduleHashes(runtime),metadata,patch_script_sha256:hash(await readFile(new URL('./curve-grid-patch.mjs',import.meta.url)))},null,2));
console.log(JSON.stringify({output,deployment:deployment.id,original_production:activeModules['production.js'],patched_production:hash(runtime['production.js']),unchanged_modules:6}));
