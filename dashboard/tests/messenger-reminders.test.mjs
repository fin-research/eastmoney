import assert from 'node:assert/strict';
import test from 'node:test';
import {sendDueReminders} from '../src/lib/server/financing/reminders.js';

function harness() {
  const saved=[],submitted=[];
  let stored=[];
  const candidate={ruleId:'r',periodId:'p',targetId:'t',ruleName:'提醒',recipientMode:'custom',recipients:['a@example.com'],leadHours:24,projectId:'project',projectName:'项目',taskName:'申报',sopName:'公司债',nodeName:'申报',debtType:'公司债',triggerDate:'2026-09-18',scheduledFor:'2026-09-17T01:00:00Z'};
  const db={prepare(sql){return {
    async all(){return sql.includes('WITH candidates')?[candidate]:stored;},
    async run(body){const rows=JSON.parse(body);saved.push(...rows);stored=rows.map(row=>({id:row.id,ruleId:row.rule_id,targetId:row.target_id,periodId:row.period_id,status:row.status}));},
  };}};
  const config={MESSENGER:{async fetch(request){submitted.push(await request.json());return Response.json({id:'message-id',status:'queued'});}}};
  return {db,config,saved,submitted};
}
test('融资入队保存中台ID而非已发送，下一轮不重复提交',async()=>{
  const h=harness(),options={...h,directory:async()=>[{id:'auth0|test',email:'a@example.com',active:true}],asOf:'2026-09-17T02:00:00Z'};
  const first=await sendDueReminders(options);
  assert.equal(first.results[0].status,'queued');
  assert.equal(h.saved[0].provider_message_id,'message-id');assert.equal(h.saved[0].sent_at,null);
  assert.equal(h.submitted[0].idempotencyKey,'reminder/r/t/p');
  assert.deepEqual(h.submitted[0].userIds,['auth0|test']);assert.equal(h.submitted[0].category,'financing');assert.equal(h.submitted[0].channel,undefined);
  const next=await sendDueReminders(options);assert.equal(next.results[0].status,'skipped');assert.equal(h.submitted.length,1);
});
test('融资提交失败可重试，dry-run不调用消息服务',async()=>{
  const h=harness();h.config.MESSENGER.fetch=async()=>new Response('Unavailable',{status:503});
  const options={...h,directory:async()=>[{id:'auth0|test',email:'a@example.com',active:true}],asOf:'2026-09-17T02:00:00Z'};
  assert.equal((await sendDueReminders(options)).results[0].status,'failed');
  h.config.MESSENGER.fetch=async()=>{throw new Error('must not send');};
  const result=await sendDueReminders({...options,dryRun:true});assert.equal(result.results[0].status,'pending');
});

test('未关联账号的指定邮箱明确失败，不产生空收件人通知',async()=>{
 const h=harness();const result=await sendDueReminders({...h,directory:async()=>[],asOf:'2026-09-17T02:00:00Z'});
 assert.equal(result.results[0].status,'failed');assert.equal(h.submitted.length,0);assert.match(h.saved[0].error_message,/未关联/);
});
