import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledTasks } from '../worker/scheduled-tasks.ts';

test('private schedule boundary rejects invalid input without starting a Workflow',async()=>{
 const created=[];const env={DATA:{fetch:async()=>Response.json({date:'2026-10-09',isTradingDay:true,previousTradingDate:'2026-10-08'})},MARKET_BRIEFING:{create:async (options)=>{created.push(options);return {id:options.id};}}};
 for(const [path,method,status] of [['/unknown','POST',404],['/scheduled','GET',405],['/scheduled','POST',400],['/scheduled?scheduledTime=NaN','POST',400],['/scheduled?scheduledTime=1','POST',400]]){
  assert.equal((await scheduledTasks(new Request('https://internal'+path,{method}),env)).status,status);
 }
 assert.equal(created.length,0);
 assert.equal((await scheduledTasks(new Request('https://internal/health'),env)).status,200);
});
test('private schedule waits for Workflow creation and preserves the scheduled date',async()=>{
 const created=[];const env={DATA:{fetch:async()=>Response.json({date:'2026-10-09',isTradingDay:true,previousTradingDate:'2026-10-08'})},MARKET_BRIEFING:{create:async (options)=>{created.push(options);return {id:options.id};}}};
 const scheduledTime=Date.parse('2026-10-09T09:00:00Z');
 assert.equal((await scheduledTasks(new Request(`https://internal/scheduled?scheduledTime=${scheduledTime}`,{method:'POST'}),env)).status,200);
 assert.equal(created.length,1);assert.equal(created[0].id,'market-briefing-2026-10-09');
});
