import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { entry, service, moduleHashes, reviewedModules } from '../report-patch.mjs';
import { schedulerEntry, schedulerModules, reviewSchedulerBaseline } from '../scheduler-patch.mjs';
const report=await readFile(new URL('../report.mjs',import.meta.url));
const original=Buffer.from('export class BondInferenceWorkflow {} export default {}');
const base={'entry.js':Buffer.from(entry),'production.js':original,'research-service.js':Buffer.from(service),'research-report.mjs':report};
const added=await schedulerModules();
test('only the entry wrapper changes; original model and report modules stay identical',()=>{
 assert.equal(reviewSchedulerBaseline('entry.js',base,report,added),false);
 const packaged={...base,...added,'entry.js':Buffer.from(schedulerEntry)};
 assert.equal(reviewSchedulerBaseline('entry.js',packaged,report,added),true);
 assert.deepEqual(moduleHashes(reviewedModules('entry.js',packaged,report,{entry:schedulerEntry,modules:added}).runtime),moduleHashes(packaged));
 for(const name of ['production.js','research-service.js','research-report.mjs']) assert.equal(moduleHashes(packaged)[name],moduleHashes(base)[name]);
});
test('unknown or changed production wrappers fail closed',()=>{
 for(const modules of [{...base,'extra.js':original},{...base,'entry.js':original},{...base,'research-service.js':original}]) assert.throws(()=>reviewSchedulerBaseline('entry.js',modules,report,added));
});
test('actual stripped upload handler rejects bad requests and waits for real scheduled runner',async()=>{
 const scheduled='data:text/javascript;base64,'+added['scheduled.js'].toString('base64');
 const handler='data:text/javascript;base64,'+Buffer.from(added['scheduled-tasks.js'].toString().replace("'./scheduled.js'",JSON.stringify(scheduled))).toString('base64');
 const {scheduledTasks}=await import(handler);
 const created=[];
 const env={DATA:{fetch:async()=>Response.json({date:'2026-10-09',isTradingDay:true,previousTradingDate:'2026-10-08'})},INFERENCE:{create:async options=>{created.push(options);return {id:options.id};}}};
 assert.equal((await scheduledTasks(new Request('https://internal/scheduled',{method:'POST'}),env)).status,400);
 assert.equal(created.length,0);
 assert.equal((await scheduledTasks(new Request('https://internal/scheduled?scheduledTime='+Date.parse('2026-10-09T00:30:00Z'),{method:'POST'}),env)).status,200);
 assert.equal(created[0].id,'bond-2026-10-09');
});
