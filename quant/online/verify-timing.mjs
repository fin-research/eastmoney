import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inferTiming, timingFeatures } from './timing-advice.mjs';

const directory=resolve(process.argv[2]);
const read=async name=>JSON.parse(await readFile(resolve(directory,name),'utf8'));
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const manifest=await read('manifest.json'),model=await read('model-main.json'),inputs=await read('inputs.json');
const expected=await read('python-result.json'),features=await read('python-features.json');
let maxError=0,checks=0;
function compare(a,b,path='') {
  if(typeof a==='number') {
    assert.ok(Number.isFinite(b)&&Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a)),path);
    maxError=Math.max(maxError,Math.abs(a-b));checks++;return;
  }
  if(a&&typeof a==='object') {
    for(const [key,value] of Object.entries(a))compare(value,b[key],`${path}/${key}`);
    return;
  }
  assert.equal(b,a,path);
}
compare(features,timingFeatures(inputs,model.features),'features');
const result=inferTiming(manifest,model,inputs);
compare(expected,result,'snapshot');
for(const entry of Object.values(manifest.models)) assert.equal(await hash(resolve(directory,entry.file)),entry.sha256);
await writeFile(resolve(directory,'result.json'),JSON.stringify(result,null,2));
const names=['timing-advice.mjs','timing-workflow.mjs','sources.json','publication.mjs','model-eligibility.mjs','worker.ts','scheduled.ts','cron-entry.ts'];
const runtime=Object.fromEntries(await Promise.all(names.map(async name=>[name,await hash(new URL(name,import.meta.url))])));
const evidence={model_version:manifest.model_version,snapshotParity:true,featureChecks:140,numericChecks:checks,maxError,
  manifest_sha256:await hash(resolve(directory,'manifest.json')),input_sha256:await hash(resolve(directory,'inputs.json')),
  result_sha256:await hash(resolve(directory,'result.json')),runtime_sha256:runtime};
await writeFile(resolve(directory,'parity.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
