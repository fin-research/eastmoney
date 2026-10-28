import {expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readdir,readFile} from 'node:fs/promises';
import {recordIssuanceSourceFact,issuanceSourceFact} from '../src/sync/bond-issuance-source-fact.ts';
import {upsertBondIssuance} from '../src/sync/bond-issuance-repository.ts';
import {syncBondHistory} from '../src/sync/bond-history-sync.ts';
it('requires evidence, preserves unknown coverage, and excludes source-confirmed non-issuance even from fixed recovery',async()=>{
 const db=new PGlite(),directory=new URL('../edb-migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
 const client={query:async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.affectedRows};}};
 const fact={batch:'test tranche',code:'123451.SH',status:'not_issued',issueDate:'2026-10-14',tenorYears:2,issuerName:'测试证券',shortName:'测试26债',reviewSha256:'a'.repeat(64),sourceUrl:'https://example.com/result.pdf',sourceSha256:'b'.repeat(64),announcementDate:'2026-10-16',physicalPage:2};
 for(const code of ['123451.SH','123451X.SH','123451X2.SH'])expect(issuanceSourceFact.parse({...fact,code}).code).toBe(code);
 const request=vi.fn(async()=>({function:'DATASTATISTICS',rows:[]}));
 try{
  await db.exec(`INSERT INTO bond_issuance(bond_code,issue_date,issuer_name,short_name,original_tenor_years,issue_amount_100m,history_invalid_code) VALUES('123451.SH','2026-10-14','测试证券','测试26债',2,30,true),('123452.SH','2026-10-14','测试证券','未知状态',2,1,false);
    INSERT INTO bond_history(bond_code,valuation_date,outstanding_balance_cny) VALUES(public.exchange_bond_code('123451.SH'),'2026-10-15',10);`);
  const before=(await db.query(`SELECT * FROM bond_issuance WHERE bond_code='123451.SH'`)).rows[0];
  await expect(db.exec(`UPDATE bond_issuance SET actual_issuance_status='not_issued' WHERE bond_code='123451.SH'`)).rejects.toThrow();
  await expect(recordIssuanceSourceFact(client as never,{...fact,tenorYears:3},true)).rejects.toThrow('does not match');
  expect(await recordIssuanceSourceFact(client as never,fact)).toMatchObject({changed:0,mode:'dry-run'});
  expect(await recordIssuanceSourceFact(client as never,fact,true)).toMatchObject({changed:1});
  expect(await recordIssuanceSourceFact(client as never,fact,true)).toMatchObject({changed:0});
  const after=(await db.query(`SELECT * FROM bond_issuance WHERE bond_code='123451.SH'`)).rows[0] as Record<string,unknown>;
  for(const [key,value] of Object.entries(before!))if(!key.startsWith('actual_issuance_'))expect(after[key]).toEqual(value);
  const input=(field:string,value:string|number)=>({dataset:'issue',entityKey:'123451.SH',field,observationDate:'2026-10-14',numericValue:typeof value==='number'?value:null,textValue:typeof value==='string'?value:null,publishedDate:null,source:'test',sourceKey:'test',sourceHash:'test'});
  await upsertBondIssuance(client as never,[input('ISSUER_NAME','测试证券'),input('BOND_NAME_ABBR','测试26债'),input('TENOR_YEAR',2),input('ACTUAL_ISSUE_SCALE',30)]);
  expect((await db.query(`SELECT actual_issuance_status FROM bond_issuance WHERE bond_code='123451.SH'`)).rows).toEqual([{actual_issuance_status:'not_issued'}]);
  await expect(upsertBondIssuance(client as never,[{...input('ISSUER_NAME','测试证券'),observationDate:'2026-10-15'},input('TENOR_YEAR',2)].map(x=>({...x,observationDate:'2026-10-15'})))).rejects.toThrow('identity conflicts');
  const result=await syncBondHistory(request,async op=>op(client as never),'2026-10-23',['2026-10-22'],'2026-10-23',['123451.SH'],[{date:'2026-10-22',code:'123451.SH'}]);
  expect(request).not.toHaveBeenCalled();expect(result.stored).toBe(0);
  expect(result.notApplicable).toEqual([{date:'2026-10-22',code:'123451.SH',reason:'not_issued'}]);
  expect(result.missing.map(x=>x.codes)).toEqual([['123452.SH']]);
  expect((await db.query('SELECT count(*)::int n FROM bond_history')).rows).toEqual([{n:1}]);
  expect((await db.query(`SELECT actual_issuance_status,issue_amount_100m,history_invalid_code FROM bond_issuance WHERE bond_code='123451.SH'`)).rows).toEqual([{actual_issuance_status:'not_issued',issue_amount_100m:30,history_invalid_code:true}]);
 }finally{await db.close();}
});

it('retains calendar dates through node-pg text results in the Shanghai timezone',async()=>{
 const {types}=await import('pg');
 const previous=process.env.TZ;process.env.TZ='Asia/Shanghai';
 try{
  for(const day of ['2026-10-14','2026-10-16']){
   const date=types.getTypeParser(1082)(day) as Date;
   expect(date.toISOString().slice(0,10)).not.toBe(day);
   expect(types.getTypeParser(25)(day)).toBe(day);
  }
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
