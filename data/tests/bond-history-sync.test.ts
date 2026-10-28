import { describe, expect, it } from 'vitest';
import { bondObservations, requireBondBudget, syncBondHistory } from '../src/sync/bond-history-sync.ts';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vi } from 'vitest';

describe('bond history daily input boundaries', () => {
  it('retains unknown fields and distinguishes a zero balance', () => {
    expect(bondObservations({function:'CSS', rows:[{code:'X.SH', YIELDCNBD:2, BONDBALANCE:0, MATUCNBD:null}]}, ['X.SH']))
      .toEqual([{code:'X.SH', yield:2, balance:0, term:null}]);
    expect(() => bondObservations({function:'CSS', rows:[{code:'Y.SH'}]}, ['X.SH'])).toThrow();
  });
  it('rejects unverified quota periods and preserves shared quota', () => {
    const row = {FUNCENAME:'EM_CSS', SECUTYPE:'全品种', PERIOD:'W', STARTDATE:'2026-09-21', ENDDATE:'2026-09-27', AVAILABEDATA:110000};
    const raw = {function:'DATASTATISTICS', rows:[row]};
    expect(() => requireBondBudget(raw,'2026-09-27',10000)).not.toThrow();
    expect(() => requireBondBudget(raw,'2026-09-27',10001)).toThrow();
    expect(() => requireBondBudget({...raw,rows:[{...row,PERIOD:'D'}]},'2026-09-27',10)).toThrow();
    expect(() => requireBondBudget({...raw,rows:[{...row,AVAILABEDATA:null}]},'2026-09-27',10)).toThrow();
  });
});

it('keeps absent, invalid and incomplete bond-days visible when quota validation fails', async () => {
  const engine = new PGlite();
  const directory = new URL('../edb-migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await engine.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  const client = { query: async (sql: string, params?: unknown[]) => {
    const result = await engine.query(sql, params); return {...result,rowCount:result.affectedRows};
  } };
  const request = vi.fn(async (_path: string) => ({function:'DATASTATISTICS',rows:[]}));
  try {
    await engine.exec(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name,history_invalid_code)
      VALUES('123451.SH','2026-01-01','测试证券',false),('123452.SH','2026-01-01','测试证券',true),
        ('123453.SH','2026-01-01','测试证券',false);
      INSERT INTO public.bond_history(bond_code,valuation_date,outstanding_balance_cny)
      VALUES(public.exchange_bond_code('123453.SH'),'2026-09-30',100);`);
    const result = await syncBondHistory(request,
      async operation => operation(client as never),'2026-10-01',['2026-09-30']);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/choice/data-statistics']);
    expect(result.stored).toBe(0);
    expect(result.failures[0]).toMatchObject({kind:'execution',error:expect.stringContaining('quota unavailable')});
    expect(result.missing.map(row => [row.reason,row.codes[0],row.dates])).toEqual([
      ['observation_absent','123451.SH',['2026-09-30']],
      ['stored_fields_incomplete','123453.SH',['2026-09-30']],
      ['invalid_code','123452.SH',['2026-09-30']],
    ]);
  } finally { await engine.close(); }
});

it('requires fields on active or unknown-balance bond-days while preserving zero-balance NULLs', async () => {
  const engine = new PGlite();
  const directory = new URL('../edb-migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await engine.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  const client = { query: async (sql: string, params?: unknown[]) => {
    const result = await engine.query(sql, params); return { ...result, rowCount: result.affectedRows };
  } };
  const request = vi.fn(async () => { throw new Error('Existing bond-days must not be charged again'); });
  const db = async <T>(operation: (value: never) => Promise<T>) => operation(client as never);
  try {
    await engine.exec(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name,maturity_date)
      VALUES('123451.SH','2026-01-01','测试证券',NULL),('123452.SH','2026-01-01','测试证券',NULL),
        ('123453.SH','2026-01-01','测试证券',NULL),('123454.SH','2026-01-01','测试证券','2026-09-01');
      INSERT INTO public.bond_history(bond_code,valuation_date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years)
      VALUES(public.exchange_bond_code('123451.SH'),'2026-09-30',NULL,0,NULL),
        (public.exchange_bond_code('123452.SH'),'2026-09-30',NULL,100,NULL),
        (public.exchange_bond_code('123453.SH'),'2026-09-30',2,NULL,3),
        (public.exchange_bond_code('123454.SH'),'2026-09-30',NULL,100,NULL);`);
    const result = await syncBondHistory(request, db, '2026-10-01', ['2026-09-30']);
    expect(result.missing).toEqual([
      { source: 'bond-history', dates: ['2026-09-30'], codes: ['123452.SH'], fields: ['YIELDCNBD','MATUCNBD'], reason: 'stored_fields_incomplete' },
      { source: 'bond-history', dates: ['2026-09-30'], codes: ['123453.SH'], fields: ['BONDBALANCE'], reason: 'stored_fields_incomplete' },
    ]);
    expect(result.failures).toEqual([{ source: 'bond-history', error: 'Unresolved bond observations', kind: 'data_gap' }]);
    expect(request).not.toHaveBeenCalled();
    expect((await engine.query(`SELECT chinabond_yield_pct,remaining_term_years FROM public.bond_history
      WHERE bond_code=public.exchange_bond_code('123451.SH')`)).rows).toEqual([{ chinabond_yield_pct: null, remaining_term_years: null }]);
  } finally { await engine.close(); }
});

it('isolates a bad code without losing valid dates and retains its gaps without requesting it again', async () => {
  const engine = new PGlite();
  const directory = new URL('../edb-migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await engine.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  const client = { query: async (sql: string, params?: unknown[]) => {
    const result = await engine.query(sql, params); return { ...result, rowCount: result.affectedRows };
  } };
  const calls: string[] = [];
  const request = async (path: string, params: URLSearchParams) => {
    if (path.endsWith('data-statistics')) return {function:'DATASTATISTICS',rows:[{
      FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-09-28',ENDDATE:'2026-10-04',AVAILABEDATA:1000000,
    }]};
    const codes = params.get('codes')!.split(','); calls.push(codes.join(','));
    if (codes.includes('245230X.SH')) throw new Error('10003008 invalid stock code');
    return {function:'CSS',rows:codes.map(code => ({code,YIELDCNBD:2,BONDBALANCE:100,MATUCNBD:3}))};
  };
  try {
    await engine.exec(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name)
      VALUES('245193.SH','2026-09-01','测试证券'),('245230X.SH','2026-09-01','测试证券');`);
    const db = async <T>(operation: (value: never) => Promise<T>) => operation(client as never);
    const result = await syncBondHistory(request, db, '2026-10-01', ['2026-09-29','2026-09-30']);
    expect(result.stored).toBe(2);
    expect(calls).toEqual(['245193.SH,245230X.SH','245193.SH','245230X.SH','245193.SH']);
    expect(result.missing).toEqual([
      {source:'bond-history',dates:['2026-09-30'],codes:['245230X.SH'],fields:['YIELDCNBD','BONDBALANCE','MATUCNBD'],reason:'invalid_code'},
      {source:'bond-history',dates:['2026-09-29'],codes:['245230X.SH'],fields:['YIELDCNBD','BONDBALANCE','MATUCNBD'],reason:'invalid_code'},
    ]);
    const resumed = await syncBondHistory(request, db, '2026-10-01', ['2026-09-29','2026-09-30']);
    expect(resumed.stored).toBe(0); expect(resumed.missing).toEqual(result.missing);
    expect(calls).toHaveLength(4);
    expect((await engine.query('SELECT bond_code,history_invalid_code FROM public.bond_issuance ORDER BY bond_code')).rows)
      .toEqual([{bond_code:'245193.SH',history_invalid_code:false},{bond_code:'245230X.SH',history_invalid_code:true}]);
    expect((await engine.query('SELECT count(*)::int AS n FROM public.bond_history')).rows).toEqual([{n:2}]);
    await engine.exec(`INSERT INTO public.bond_history(bond_code,valuation_date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years)
      VALUES(public.exchange_bond_code('245230X.SH'),'2026-09-28',2,0,0);`);
    expect((await syncBondHistory(request, db, '2026-10-01', ['2026-09-29','2026-09-30'])).missing).toEqual([]);
    expect(calls).toHaveLength(4);
  } finally { await engine.close(); }
});
it('repairs only original authorized codes while retaining later candidates as unprocessed gaps', async () => {
  const engine=new PGlite();
  const directory=new URL('../edb-migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())
    await engine.exec(await readFile(new URL(name,directory),'utf8'));
  const client={query:async(sql:string,params?:unknown[])=>{const r=await engine.query(sql,params);return {...r,rowCount:r.affectedRows};}};
  const paid:string[]=[];
  const request=async(path:string,params:URLSearchParams)=>{
    if(path.endsWith('data-statistics'))return {function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-10-19',ENDDATE:'2026-10-25',AVAILABEDATA:1000000}]};
    const codes=params.get('codes')!.split(',');paid.push(...codes);
    return {function:'CSS',rows:codes.map(code=>({code,YIELDCNBD:2,BONDBALANCE:100,MATUCNBD:3}))};
  };
  try {
    await engine.exec(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name)
      VALUES('123451.SH','2026-01-01','测试证券'),('123452.SH','2026-01-01','测试证券');`);
    const result=await syncBondHistory(request,async op=>op(client as never),'2026-10-23',['2026-10-22'],'2026-10-23',['123451.SH']);
    expect(paid).toEqual(['123451.SH']);expect(result.stored).toBe(1);
    expect(result.missing).toEqual([{source:'bond-history',dates:['2026-10-22'],codes:['123452.SH'],fields:['YIELDCNBD','BONDBALANCE','MATUCNBD'],reason:'observation_absent'}]);
  } finally {await engine.close();}
});
