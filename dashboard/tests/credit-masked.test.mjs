import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { register } from 'tsx/esm/api';
register();
const { creditDatabase, seedCredit, applyCreditMigration } = await import('./helpers/credit-database.mjs');
const { loadCreditMasked } = await import('../src/lib/server/credit-masked.ts');
const { loadCreditReport } = await import('../src/lib/server/credit-repository.ts');
const { creditMaskedReportSchema } = await import('../src/lib/credit/masked.ts');
const { handleDashboardMcp } = await import('../src/lib/server/mcp.ts');

test('masked rename preserves values and grants and removes the old names', async t => {
  const db=await creditDatabase(t,false,false,false,true);await seedCredit(db);
  for(const name of ['0018_credit_entries.sql','0019_finalize_credit_entries.sql','0020_credit_verified.sql','0021_correct_agricultural_bank_renewal.sql','0022_credit_ai_ledger.sql'])await applyCreditMigration(db,name);
  await db.exec('CREATE ROLE masked_reader; GRANT EXECUTE ON FUNCTION credit.ai_ledger_as_of(date) TO masked_reader; GRANT SELECT ON credit.ai_ledger TO masked_reader');
  const before=await db.query("SELECT * FROM credit.ai_ledger_as_of('2026-08-21')");
  await applyCreditMigration(db,'0023_credit_masked.sql');
  assert.deepEqual((await db.query("SELECT * FROM credit.masked_as_of('2026-08-21')")).rows,before.rows);
  assert.equal((await db.query("SELECT has_function_privilege('masked_reader','credit.masked_as_of(date)','EXECUTE') AND has_table_privilege('masked_reader','credit.masked','SELECT') AS granted")).rows[0].granted,true);
  const objects=(await db.query("SELECT to_regclass('credit.ai_ledger') AS old_view,to_regprocedure('credit.ai_ledger_as_of(date)') AS old_function")).rows[0];
  assert.equal(objects.old_view,null);assert.equal(objects.old_function,null);
});

test('actual GET and MCP return only the SQL whitelist and reject identity queries before connecting', async t => {
  const db=await creditDatabase(t); await seedCredit(db,'2026-08-21','API身份哨兵',{notes:'备注哨兵'});
  let connections=0;
  globalThis.__creditMaskedConnect=async fn=>{connections++;return fn(db)};
  t.after(()=>delete globalThis.__creditMaskedConnect);
  const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
  const code=(await build({entryPoints:['src/routes/api/credit/+server.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'postgres-fixture',setup(plugin){
    plugin.onResolve({filter:/postgres\.ts$/},()=>({path:'postgres',namespace:'fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export async function withPostgres(connection,name,fn){return globalThis.__creditMaskedConnect(fn)}'}));
  }}]})).outputFiles[0].text;
  const {GET}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const get=query=>GET({url:new URL('https://eastmoney.hasbai.xyz/api/credit?'+query),platform:{env:{}}});
  for(const query of ['view=masked&date=2026-02-30','view=masked&institution=API身份哨兵','view=masked&institutionId=0','view=masked&institutionId=abc','view=masked&institutionId=','view=masked&institutionId=9223372036854775808','view=masked&month=2026-08','view=masked&view=usage'])
    assert.equal((await get(query)).status,400);
  assert.equal(connections,0);
  const response=await get('view=masked&date=2026-08-21');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const report=await response.json();assert.deepEqual(report,await loadCreditMasked(db,'2026-08-21'));assert.doesNotMatch(JSON.stringify(report),/哨兵/);
  const identity={id:'auth0|test',auth0Id:'auth0|test',email:'test@18.cn',issuedAt:1,expiresAt:9999999999,authorization:{roles:[],permissions:[],mode:'enforce'}};
  const env={IDENTITY:{async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/mcp/policies')return Response.json({allowed:(await request.json()).map(()=>true)});
    const target=new URL(url.searchParams.get('target'),'https://eastmoney.hasbai.xyz');
    assert.equal(target.searchParams.get('view'),'masked');return GET({url:target,platform:{env:{}}});
  }}};
  const mcp=await handleDashboardMcp(new Request('https://eastmoney.hasbai.xyz/api/mcp',{method:'POST',headers:{Host:'eastmoney.hasbai.xyz','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'credit_report',arguments:{query:{date:'2026-08-21'}}}})}),env,identity);
  const text=await mcp.text();assert.doesNotMatch(text,/哨兵|institution_name|notes/);
  const payload=mcp.headers.get('Content-Type')?.includes('text/event-stream')?text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(value=>value.id===1):JSON.parse(text);
  assert.deepEqual(payload.result.structuredContent.data,report);
  assert.equal((await get('view=masked&date=2026-08-20')).status,404);
});

test('AI SQL omits identities and matches the ledger by stable ID and as-of date', async t => {
  const db = await creditDatabase(t);
  await seedCredit(db, '2026-08-01', '机构身份哨兵', { handler:'经办身份哨兵', bank_office:'办公室哨兵', detail:'说明哨兵', notes:'备注哨兵', bond_investment_detail:'债券哨兵', other_detail:'其它哨兵', legal_overdraft_used:1.2, other_used:0.3 });
  await db.exec("INSERT INTO public.client(name,type) VALUES ('客户身份哨兵','银行'); INSERT INTO credit.institution_client(institution_id,institution_name,client_id,notes) SELECT i.id,i.name,c.id,'关联哨兵' FROM credit.institution i CROSS JOIN public.client c WHERE c.name='客户身份哨兵'");
  const id = (await db.query('SELECT id::text FROM credit.institution')).rows[0].id;
  for (const [table,type,amount] of [['income_certificate','收益凭证','231000001.01'], ['debt','同业拆借','200000000.02']])
    await db.query(`INSERT INTO financing.${table}(debt_type,name,amount,activated_at,maturity_date,client_id) SELECT $1,'融资身份哨兵',$2,'2026-08-21','2026-08-24',id FROM public.client WHERE name='客户身份哨兵'`, [type,amount]);
  const bond = (await db.query("INSERT INTO financing.bond(debt_type,subtype,name,amount,issue_date,maturity_date) VALUES('债券','小公募','债名哨兵',100000001.01,'2026-08-21','2026-08-24') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO financing.bond_investors(bond_id,investor_id,amount) SELECT $1,id,100000001.01 FROM public.client WHERE name='客户身份哨兵'", [bond]);
  await db.query("SELECT credit.append_entry('2026-08-22','机构身份哨兵','{\"total\":12,\"verified\":true}',NULL,'increase')");
  for (const date of ['2026-08-20','2026-08-21','2026-08-22','2026-08-24','2026-08-30','2026-08-31']) {
    const ai = await loadCreditMasked(db,date,id), regular = (await loadCreditReport(db,date)).institutions[0];
    const row = ai.institutions[0];
    assert.equal(row.institution_id,id); assert.equal(row.status,regular.status);
    assert.equal(Number(row.total_limit),regular.totalLimit); assert.equal(Number(row.total_used),regular.totalUsed);
    assert.equal(Number(row.total_available),regular.totalRemaining);
    assert.ok(Math.abs(Number(row.utilization_pct)-regular.utilization)<1e-10);
    for (const type of ['bond_investment','yield_certificate','interbank_lending','legal_overdraft','other']) {
      const item = regular.items.find(item => item.type===type);
      assert.equal(row[`${type}_used`]===null ? null : Number(row[`${type}_used`]),item.usedAmount);
    }
    assert.equal(row.verified,date==='2026-08-22');
    assert.doesNotMatch(JSON.stringify(ai),/哨兵|institution_name|client|handler|notes|detail|created/);
  }
  // Prove the SQL has no hidden institution/name dependency, including helper calls.
  await db.exec('CREATE ROLE ai_reader; GRANT USAGE ON SCHEMA credit,financing TO ai_reader; GRANT SELECT ON credit.entry,credit.institution_client,financing.debt,financing.bond,financing.bond_investors TO ai_reader; GRANT EXECUTE ON FUNCTION financing.credit_usage_as_of(date),credit.masked_as_of(date) TO ai_reader; GRANT SELECT ON credit.masked TO ai_reader; SET ROLE ai_reader');
  assert.equal((await loadCreditMasked(db,'2026-08-22',id)).institutions.length,1);
  await db.query('SELECT * FROM credit.masked');
  await assert.rejects(db.query('SELECT * FROM credit.institution'),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM public.client'),/permission denied/);
  await db.exec('RESET ROLE');
});

test('AI projection preserves missing associations, zero denominator, inheritance and revocation', async t => {
  const db = await creditDatabase(t);
  await seedCredit(db,'2026-08-01','无关联',{total:0});
  await db.query('DELETE FROM credit.institution_client');
  let row = (await loadCreditMasked(db,'2026-08-21')).institutions[0];
  assert.equal(row.total_limit,'0.000000'); assert.equal(row.total_used,null); assert.equal(row.total_available,null); assert.equal(row.utilization_pct,null);
  const id=row.institution_id;
  await seedCredit(db,'2026-08-01','零总额',{total:0});
  row=(await loadCreditMasked(db,'2026-08-21')).institutions[1];assert.equal(row.utilization_pct,null);assert.equal(Number(row.total_used),3);
  await db.query("SELECT credit.append_entry('2026-08-22','无关联','{\"expiry_date\":\"1970-01-01\"}',NULL,'revocation')");
  assert.equal((await loadCreditMasked(db,'2026-08-21',id)).institutions.length,1);
  assert.equal((await loadCreditMasked(db,'2026-08-22',id)).institutions.length,0);
  assert.equal((await loadCreditMasked(db,'2026-08-21','999999')).institutions.length,0);
  await assert.rejects(loadCreditMasked(db,'2026-07-31'),error=>error.status===404);
});

test('masked response schema rejects identity-bearing fields', async t => {
  const db=await creditDatabase(t); await seedCredit(db);
  const report=await loadCreditMasked(db,'2026-08-21');
  assert.deepEqual(creditMaskedReportSchema.parse(report),report);
  for (const payload of [{...report,institution_name:'身份哨兵'}, {...report,institutions:[{...report.institutions[0],notes:'身份哨兵'}]}])
    assert.equal(creditMaskedReportSchema.safeParse(payload).success,false);
});
