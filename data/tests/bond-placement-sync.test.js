import {expect,it} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {syncBondPlacement} from '../src/sync/bond-placement-sync.ts';
async function database(){
 const engine=new PGlite(), directory=new URL('../edb-migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await engine.exec(await readFile(new URL(name,directory),'utf8'));
 await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name)
 VALUES('123456.SH','2026-08-01','测试证券')`);
 const client={query:async(...args)=>{const r=await engine.query(...args);return {...r,rowCount:r.affectedRows};}};
 return {engine,client};
}
const quota={function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-09-28',ENDDATE:'2026-10-04',AVAILABEDATA:1000000}]};
it('empty metadata is checked once per day and missing classification stays visible',async()=>{
 const {engine,client}=await database();let paid=0;
 const request=async route=>route.endsWith('data-statistics')?quota:(paid++,{function:'CSS',rows:[]});
 try{
  await syncBondPlacement(request,operation=>operation(client),'2026-09-28');
  const result=await syncBondPlacement(request,operation=>operation(client),'2026-09-28');
  expect(paid).toBe(1);expect(result.missing).toHaveLength(1);
  expect((await engine.query('SELECT placement_type FROM public.bond_issuance')).rows[0].placement_type).toBeNull();
 }finally{await engine.close();}
});
it('failed projection leaves the bond eligible for a paid incremental retry',async()=>{
 const {engine,client}=await database();let paid=0,fail=true;
 const request=async route=>route.endsWith('data-statistics')?quota:(paid++,{function:'CSS',rows:[{code:'123456.SH',RAISEWAY:'公募',MATURITYDATE:'2029-08-01'}]});
 const faulty={query:async(sql,args)=>{if(fail&&sql.includes('UPDATE public.bond_issuance SET')){fail=false;throw new Error('database unavailable');}return client.query(sql,args);}};
 try{
  expect((await syncBondPlacement(request,operation=>operation(faulty),'2026-09-28')).failures)
    .toContainEqual({source:'bond-placement',error:'database unavailable'});
  await syncBondPlacement(request,operation=>operation(client),'2026-09-28');
  expect(paid).toBe(2);
  expect((await engine.query('SELECT placement_type,maturity_date::text FROM public.bond_issuance')).rows[0]).toEqual({placement_type:'公募',maturity_date:'2029-08-01'});
 }finally{await engine.close();}
});

it('isolates invalid codes, persists valid metadata and excludes only the confirmed singleton on later runs',async()=>{
 const {engine,client}=await database();const calls=[];
 await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name)
 VALUES('123457.SH','2026-08-01','测试证券')`);
 const request=async(route,params)=>{
  if(route.endsWith('data-statistics'))return quota;
  const codes=params.get('codes').split(',');calls.push(codes);
  if(codes.includes('123457.SH'))throw new Error('10003008 invalid stock code');
  return {function:'CSS',rows:codes.map(code=>({code,RAISEWAY:'公募',MATURITYDATE:'2029-08-01'}))};
 };
 try{
  const first=await syncBondPlacement(request,operation=>operation(client),'2026-09-28');
  expect(first.stored).toBe(1);expect(first.missing).toEqual([{source:'bond-placement',codes:['123457.SH'],dates:['2026-08-01'],fields:['RAISEWAY'],reason:'invalid_code'}]);
  await syncBondPlacement(request,operation=>operation(client),'2026-09-28');
  expect(calls).toEqual([['123456.SH','123457.SH'],['123456.SH'],['123457.SH']]);
  expect((await engine.query('SELECT bond_code,placement_invalid_code,placement_type FROM public.bond_issuance ORDER BY bond_code')).rows)
   .toEqual([{bond_code:'123456.SH',placement_invalid_code:false,placement_type:'公募'},
     {bond_code:'123457.SH',placement_invalid_code:true,placement_type:null}]);
 }finally{await engine.close();}
});
