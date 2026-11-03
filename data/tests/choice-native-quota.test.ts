import assert from 'node:assert/strict';
import { test } from 'vitest';
import { edbQuotaRequests, assertQuotaAllowed, executeAccountedEdb, statisticsRequest, statisticsRows, ChoiceQuotaError } from '../src/choice/native/quota.ts';
import { percentMetadataRequest, decodePercentMetadata, percentFlags } from '../src/choice/native/percent.ts';
import { readFileSync } from 'node:fs';
const allowed = { code: 200, data: [{ flag: true }] };
test('EDB preflight and accounting retain SDK requests and await order', async () => {
  assert.deepEqual(edbQuotaRequests('synthetic-token', 2), [
    {serverType: 202, path:'/api/auth', service:'API_AUTH', body:'{"subjectName":"EM_EDB","tokenID":"synthetic-token"}\n'},
    {serverType: 202, path:'/api/count', service:'API_COUNT', body:'{"num":"2","subjectName":"EM_EDB","tokenID":"synthetic-token"}\n'},
  ]);
  const calls: string[] = [];
  const result = await executeAccountedEdb('synthetic-token', async request => {calls.push(request.path + ':' + (JSON.parse(request.body).num ?? '')); return allowed;}, async () => {
    calls.push('query'); return {value:42,sheets:[{name:'A',rows:[[null]]},{name:'A',rows:[[1]]},{name:'B',rows:[[2],[3]]},{name:'EMPTY',rows:[]}]};
  });
  assert.equal(result,42); assert.deepEqual(calls,['/api/auth:','query','/api/auth:','/api/count:2']);
});
test('denials block queries; count failures never return decoded data', async () => {
  let called = false;
  await assert.rejects(executeAccountedEdb('synthetic-token', async()=>({code:200,data:[{flag:false,returnCode:9}]}), async()=>{called=true;return {value:1,sheets:[]};}), ChoiceQuotaError);
  assert.equal(called,false);
  await assert.rejects(executeAccountedEdb('synthetic-token', async request => request.path === '/api/count' ? {code:200,data:[{flag:false}]} : allowed, async()=>({value:1,sheets:[{name:'A',rows:[[1]]}]})), ChoiceQuotaError);
  for(const value of [{code:0,data:[{flag:true}]},{code:200,data:[]},{code:200,data:[{flag:true},{flag:false}]},{code:200,data:[{}]}]) assert.throws(()=>assertQuotaAllowed(value), ChoiceQuotaError);
});
test('statistics use GetToken/type202, application code200, upstream quota values and string output', () => {
  const request = statisticsRequest('synthetic-token',{funcName:'EM_EDB',indicators:'THRESHOLD,USEDDATA,USEDRATIO,AVAILABEDATA'},'2026-11-02');
  assert.equal(request.serverType,202);
  assert.equal(request.body,'{"column":"THRESHOLD,USEDDATA,USEDRATIO,AVAILABEDATA","endDate":"2026-11-02","startDate":"2026-11-02","subjectName":"EM_EDB","tokenID":"synthetic-token"}\n');
  assert.deepEqual(statisticsRows({code:200,data:[{THRESHOLD:100,USEDDATA:30,USEDRATIO:'upstream-exact',AVAILABEDATA:65}]},request.fields),[{THRESHOLD:'100',USEDDATA:'30',USEDRATIO:'upstream-exact',AVAILABEDATA:'65'}]);
  assert.throws(()=>statisticsRows({code:0,data:[{}]},request.fields),ChoiceQuotaError);
  assert.throws(()=>statisticsRows({code:429},request.fields),{upstreamCode:10000016});
  assert.throws(()=>statisticsRows({code:200,data:[]},request.fields),{upstreamCode:10000009});
});
test('metadata request and synthetic raw sheet exercise exact STYPE map extraction', () => {
  assert.equal(new TextDecoder().decode(percentMetadataRequest().frame.subarray(14)),'$-rpt\r\n$name=EM_API_PERCENTFLAG\r\n$ifWriteWithNetStream=0');
  const hex=JSON.parse(readFileSync(new URL('./fixtures/choice-native/quota-fixtures.json',import.meta.url),'utf8')).percent;
  const metadata=decodePercentMetadata(new Uint8Array(Buffer.from(hex,'hex')));
  assert.deepEqual(percentFlags(metadata,'CSS',['pct','CLOSE'],1),[true,false]);
  assert.deepEqual(percentFlags(metadata,'CSS',['pct'],2),[true]);
  assert.deepEqual(percentFlags(metadata,'CSD',['pct'],1),[false]);
  assert.deepEqual(percentFlags(metadata,'CSD',['pct'],1000),[true]);
  assert.deepEqual(percentFlags(metadata,'CSS',['pct'],1000),[false]);
});
