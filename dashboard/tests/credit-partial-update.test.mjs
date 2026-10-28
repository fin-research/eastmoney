import assert from 'node:assert/strict';
import test from 'node:test';
import {creditDatabase,seedCredit} from './helpers/credit-database.mjs';
import {loadCreditReport,loadCreditData,saveCreditInstitution} from '../src/lib/server/credit-repository.ts';
import {loadCreditStates} from '../src/lib/server/credit-snapshots.ts';
import {applyCreditDataUpdate as applyCreditUpdate} from '../src/lib/credit/data.ts';
import {buildCreditReport} from '../src/lib/credit/build-report.ts';

const orderCollections=input=>{const report=input.savedStates?buildCreditReport(input):input;return({...report,
  weeklyNews:[...report.weeklyNews].sort((a,b)=>a.reportDate.localeCompare(b.reportDate)||a.institutionName.localeCompare(b.institutionName)),
  previousWeeklyNews:[...(report.previousWeeklyNews??[])].sort((a,b)=>a.reportDate.localeCompare(b.reportDate)||a.institutionName.localeCompare(b.institutionName)),
  recentApprovals:[...report.recentApprovals].sort((a,b)=>b.reportDate.localeCompare(a.reportDate)||a.institutionName.localeCompare(b.institutionName)),
  limitChanges:[...report.limitChanges].sort((a,b)=>a.institutionName.localeCompare(b.institutionName))});};

test('save returns scoped canonical data; browser summary and events equal a fresh report',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-01','甲银行',{expiry_date:'2026-09-30'});
  await seedCredit(db,'2026-08-01','乙银行',{expiry_date:'2026-09-30',total:20});
  await db.query("SELECT credit.append_entry('2026-08-12','乙银行','{\"total\":25}',NULL,'increase')");
  const before=await loadCreditData(db,'2026-08-15');
  const untouched=before.savedStates.find(row=>row.date===before.reportDate&&row.data.institution_name==='乙银行');
  const queries=[];
  const tracked={query:async(sql,params)=>{queries.push({sql,params});return db.query(sql,params);}};
  const result=await saveCreditInstitution(tracked,{operation:'increase',reportDate:'2026-08-15',viewDate:'2026-08-15',calendarMonth:'2026-08',institutionName:'甲银行',changes:{institution:{totalLimit:12}}});
  assert.equal(result.scope,'institution');
  assert.ok(result.data.savedStates.every(row=>row.data.institution_name==='甲银行'));
  assert.equal('summary' in result,false);
  const requests=queries.find(q=>q.sql.includes('jsonb_to_recordset')&&q.sql.includes('credit.entry_as_of')&&!q.sql.includes('"totalAvailable"'));
  assert.ok(JSON.parse(requests.params[0]).every(row=>Array.isArray(row.names)&&row.names.every(name=>name==='甲银行')));
  const reactive=applyCreditUpdate(before,result,'2026-08');
  assert.equal(reactive.savedStates.find(row=>row.date===reactive.reportDate&&row.data.institution_name==='乙银行'),untouched);
  assert.deepEqual(buildCreditReport(reactive),await loadCreditReport(db,'2026-08-15'));
  assert.equal(buildCreditReport(reactive).summary.totalLimit,37);
  assert.equal(applyCreditUpdate(before,{...result,viewDate:'2026-08-16'},'2026-08'),before);
  assert.equal(applyCreditUpdate(before,result,'2026-09'),before);
});

test('historical maintenance and future changes update the selected view without switching its date',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01');
  const before=await loadCreditData(db,'2026-08-15','2026-09');
  const past=await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-08-08',viewDate:'2026-08-15',calendarMonth:'2026-09',institutionName:'甲银行',changes:{items:[{type:'bond_investment',limitAmount:0,secondaryUsedAmount:0}],institution:{confidentialityStatus:false,notes:''}}});
  assert.equal(buildCreditReport(past.data).institutions[0].totalUsed,0);assert.equal(buildCreditReport(past.data).institutions[0].totalLimit,10);
  const updated=applyCreditUpdate(before,past,'2026-09');
  assert.deepEqual(orderCollections(updated),orderCollections(await loadCreditReport(db,'2026-08-15','2026-09')));
  const future=await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-01',viewDate:'2026-08-15',calendarMonth:'2026-09',institutionName:'甲银行',changes:{institution:{notes:'未来备注'}}});
  assert.equal(future.viewDate,'2026-08-15');assert.equal(buildCreditReport(future.data).institutions[0].totalLimit,10);
  assert.deepEqual(orderCollections(applyCreditUpdate(updated,future,'2026-09')),orderCollections(await loadCreditReport(db,'2026-08-15','2026-09')));
});

test('filtered canonical snapshots preserve values, empty lists and reset periods; browser summaries retain report precision',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-01','甲银行',{effective_date:'2026-08-01',expiry_date:'2026-08-31',other_used:.000001});
  await seedCredit(db,'2026-08-01','乙银行');
  await db.query("SELECT credit.append_entry('2026-08-10','甲银行','{\"effective_date\":\"2026-09-01\",\"expiry_date\":\"2026-09-30\"}',NULL,'renewal')");
  const full=(await db.query("SELECT to_jsonb(s) AS data FROM credit.entry_as_of('2026-08-15') s WHERE institution_name='甲银行'")).rows;
  const filtered=(await db.query("SELECT to_jsonb(s) AS data FROM credit.entry_as_of('2026-08-15',ARRAY['甲银行','甲银行']) s")).rows;
  assert.deepEqual(filtered,full);
  assert.equal((await db.query("SELECT * FROM credit.entry_as_of('2026-08-15',ARRAY[]::text[])")).rows.length,0);
  assert.deepEqual((await db.query("SELECT to_jsonb(s) AS data FROM credit.entry_as_of('2026-08-15',NULL::text[]) s ORDER BY institution_name")).rows,
    (await db.query("SELECT to_jsonb(s) AS data FROM credit.entry_as_of('2026-08-15') s ORDER BY institution_name")).rows);
  let states=await loadCreditStates(db,[{date:'2026-08-15',names:['甲银行']}]);
  assert.equal(states[0].data.expiry_date,'2026-09-30');
  for(const date of ['2026-08-15','2026-09-01']) assert.deepEqual(buildCreditReport(await loadCreditData(db,date)).summary,(await loadCreditReport(db,date)).summary);
  await db.query("SELECT credit.append_entry('2026-08-16','甲银行','{\"status\":\"revoked\",\"expiry_date\":\"1970-01-01\"}',NULL,'revocation')");
  await db.query("SELECT credit.append_entry('2026-08-17','甲银行','{\"status\":\"approved\",\"expiry_date\":\"2026-09-30\"}',NULL,'new')");
  states=await loadCreditStates(db,[{date:'2026-08-18',names:['甲银行']}]);
  assert.equal(states[0].data.expiry_date,'2026-09-30');
  assert.equal((await loadCreditReport(db,'2026-08-18')).institutions.find(row=>row.institutionName==='甲银行').effectiveStatus,'approved');
});


test('changing the first-week comparison date or history start refreshes dependent collections without replacing other rows',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-01','甲银行',{effective_date:'2026-08-01',expiry_date:'2026-08-31'});
  await seedCredit(db,'2026-08-01','乙银行',{effective_date:'2026-08-01',expiry_date:'2026-08-02'});
  let before=await loadCreditData(db,'2026-08-05');
  let update=await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-08-03',viewDate:'2026-08-05',institutionName:'甲银行',changes:{institution:{notes:'补录'}}});
  assert.equal(update.data.previousDate,'2026-08-03');assert.equal(update.scope,'context');
  assert.deepEqual(orderCollections(applyCreditUpdate(before,update,'2026-08')),orderCollections(await loadCreditReport(db,'2026-08-05')));
  before=await loadCreditData(db,'2026-08-15');
  update=await saveCreditInstitution(db,{operation:'new',reportDate:'2026-07-30',viewDate:'2026-08-15',institutionName:'丙银行',changes:{institution:{status:'applying',institutionType:'城商行',confidentialityStatus:false}}},null,true);
  assert.equal(update.scope,'context');assert.ok(update.data.savedStates.filter(row=>row.date===update.viewDate).every(row=>row.data.institution_name===update.institutionName));
  assert.deepEqual(orderCollections(applyCreditUpdate(before,update,'2026-08')),orderCollections(await loadCreditReport(db,'2026-08-15')));
  const outside=await loadCreditData(db,'2026-08-15','2027-01');
  const earlier=await saveCreditInstitution(db,{operation:'new',reportDate:'2026-07-29',viewDate:'2026-08-15',calendarMonth:'2027-01',institutionName:'丁银行',changes:{institution:{status:'applying',institutionType:'城商行',confidentialityStatus:false}}},null,true);
  assert.equal(earlier.scope,'context');
  assert.deepEqual(orderCollections(applyCreditUpdate(outside,earlier,'2027-01')),orderCollections(await loadCreditReport(db,'2026-08-15','2027-01')));
});


test('creating a future institution confirms the write while keeping the current header snapshot',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01');
  const before=await loadCreditData(db,'2026-08-15','2026-09');
  const update=await saveCreditInstitution(db,{operation:'new',reportDate:'2026-09-01',viewDate:'2026-08-15',calendarMonth:'2026-09',institutionName:'未来银行',changes:{institution:{institutionType:'城商行',status:'approved',confidentialityStatus:false,totalLimit:8}}},null,true);
  assert.equal(update.data.savedStates.some(row=>row.date===update.viewDate),false);assert.equal(update.viewDate,'2026-08-15');
  assert.deepEqual(orderCollections(applyCreditUpdate(before,update,'2026-09')),orderCollections(await loadCreditReport(db,'2026-08-15','2026-09')));
});

test('the credit client displays the sanitized Gateway backend error',async()=>{
  const {fetchCreditReport,updateCreditInstitution}=await import('../src/lib/credit/client.ts');
  const fetcher=async()=>Response.json({detail:'业务服务暂时不可用，请稍后重试',code:'BACKEND_UNAVAILABLE'},{status:503});
  await assert.rejects(fetchCreditReport(null,fetcher),/业务服务暂时不可用/);
  await assert.rejects(updateCreditInstitution({operation:'maintenance',reportDate:'2026-10-09',institutionName:'甲',changes:{institution:{notes:'x'}}},fetcher),/业务服务暂时不可用/);
});

test('raw credit responses reject incomplete dates, malformed records and out-of-scope patches',async()=>{
  const {fetchCreditData,updateCreditInstitution}=await import('../src/lib/credit/client.ts');
  const {creditDataFixture,creditDataPatch}=await import('./helpers/credit-data-fixture.mjs');
  const institution=name=>({institutionName:name,status:'approved',totalLimit:10,totalUsed:0,items:[],clients:[]});
  const report={summary:{reportDate:'2026-08-15'},availableDates:['2026-08-01'],previousDate:null,
    institutions:[institution('甲银行'),institution('乙银行')],recentApprovals:[{institutionName:'乙银行',reportDate:'2026-08-12',eventType:'increase',previousAmount:8,currentAmount:10}]};
  const raw=creditDataFixture(report),input={operation:'maintenance',institutionName:'甲银行',reportDate:'2026-08-15',viewDate:'2026-08-15',calendarMonth:'2026-08',changes:{institution:{notes:'x'}}};
  assert.deepEqual(await fetchCreditData(null,async()=>Response.json(raw)),JSON.parse(JSON.stringify(raw)));
  for(const invalid of [{...raw,calendarStart:undefined},{...raw,savedStates:[{date:raw.reportDate,data:null,previous_period:null}]},{...raw,usage:[{date:raw.reportDate,institution_name:'甲银行',item_type:'other',amount:'0'}]}])
    await assert.rejects(fetchCreditData(null,async()=>Response.json(invalid)),/数据结构无效/);
  const patch=creditDataPatch(report,input);
  assert.ok([...patch.data.rows,...patch.data.links,...patch.data.usageEventRows,...patch.data.usage].every(row=>row.institution_name===input.institutionName));
  assert.ok(patch.data.savedStates.every(row=>row.data.institution_name===input.institutionName));
  assert.deepEqual(await updateCreditInstitution(input,async()=>Response.json(patch)),JSON.parse(JSON.stringify(patch)));
  await assert.rejects(updateCreditInstitution(input,async()=>Response.json({...patch,data:raw})),/数据范围无效/);
  await assert.rejects(updateCreditInstitution(input,async()=>Response.json({...patch,viewDate:'2026-08-16'})),/数据结构无效/);
});
