import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { syncBondHistory } from '../src/sync/bond-history-sync.ts';
import type { DatabaseClient } from '../src/sync/postgres.ts';
import { readFile, readdir } from 'node:fs/promises';

it('preserves an observation inserted after coverage discovery and before paid response persistence',async()=>{
 const db=new PGlite();
 try {
  const directory=new URL('../edb-migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())
   await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.exec(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name,history_invalid_code,maturity_date)
   VALUES('112840.SZ','2026-01-01','测试证券',false,'2028-01-01');`);
  let cssCalls=0;
  const result=await syncBondHistory(async path=>{
   if(path==='/choice/data-statistics')return {function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-10-26',ENDDATE:'2026-11-01',AVAILABEDATA:1000000}]};
   cssCalls++;
   // A concurrent successful writer commits a good observation after discovery.
   await db.exec("INSERT INTO public.bond_history VALUES(20112840,'2026-10-23',2.31,2200000000,1.25)");
   return {function:'CSS',rows:[{code:'112840.SZ',YIELDCNBD:9.99,BONDBALANCE:1,MATUCNBD:9}]};
  },async operation=>operation(db as unknown as DatabaseClient),'2026-10-26',['2026-10-23']);
  expect(cssCalls).toBe(1);
  expect((await db.query('SELECT chinabond_yield_pct,outstanding_balance_cny,remaining_term_years FROM public.bond_history')).rows)
   .toEqual([{chinabond_yield_pct:2.31,outstanding_balance_cny:2200000000,remaining_term_years:1.25}]);
  expect(result.stored).toBe(0);
  expect(result.missing).toEqual([]);
 } finally {await db.close();}
});
