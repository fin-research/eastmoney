import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { recordBondHistoryIdentities } from '../src/sync/bond-history-identity.ts';
import { syncBondHistory } from '../src/sync/bond-history-sync.ts';
import type { DatabaseClient } from '../src/sync/postgres.ts';

it('normalizes only evidenced dated identities, preserves raw rows, and exposes conflicts', async () => {
  const db = new PGlite();
  try {
    const directory = new URL('../edb-migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(name, directory), 'utf8'));
    }
    await db.exec(`INSERT INTO bond_issuance(bond_code,issue_date,issuer_name,maturity_date)
      VALUES ('123456.SH','2025-01-01','测试证券','2030-01-01'),
      ('123456X.SH','2026-01-01','测试证券','2030-01-01'),
      ('123456X1.SH','2026-01-01','测试证券','2030-01-01'),
      ('123456X2.SH','2026-02-01','测试证券','2030-01-01'),
      ('234567X.SH','2026-01-01','测试证券','2030-01-01'),
      ('999999.SH','2026-01-01','其他证券','2030-01-01');`);
    const fact = (alias: string, target: string, date: string) => db.query(`INSERT INTO bond_history_identity
      (source_code,canonical_code,effective_from,official_url,official_sha256,official_pages,vendor_mapping_sha256,review_sha256)
      VALUES($1,$2,$3,'https://example.com/listing.pdf',$4,ARRAY[2],$4,$4)`, [alias, target, date, 'a'.repeat(64)]);
    await expect(fact('123456X.SH', '999999.SH', '2026-10-20')).rejects.toThrow('conflicts');
    await expect(fact('123456X1.SH', '123456.SH', '2026-10-20')).rejects.toThrow();
    await expect(fact('234567X.SH', '123456X1.SH', '2026-10-20')).rejects.toThrow();
    await expect(fact('123456X.SH', '123456.SH', '2025-10-20')).rejects.toThrow('conflicts');
    await fact('123456X.SH', '123456.SH', '2026-10-20');
    await fact('123456X2.SH', '123456.SH', '2026-10-22');
    await expect(fact('123456.SH', '234567X.SH', '2026-10-22')).rejects.toThrow('direct and final');
    await expect(db.exec(`UPDATE bond_issuance SET issuer_name='其他证券' WHERE bond_code='123456X.SH'`)).rejects.toThrow('reviewed');
    await expect(db.exec(`UPDATE bond_history_identity SET effective_from='2026-10-21'`)).rejects.toThrow('immutable');
    await db.exec(`INSERT INTO bond_history VALUES
      (public.exchange_bond_code('123456.SH'),'2026-10-19',2,100,3),
      (public.exchange_bond_code('123456X.SH'),'2026-10-19',NULL,100,NULL),
      (public.exchange_bond_code('123456.SH'),'2026-10-26',2,100,3),
      (public.exchange_bond_code('123456X.SH'),'2026-10-26',NULL,100,NULL),
      (public.exchange_bond_code('123456X2.SH'),'2026-10-26',NULL,100,NULL),
      (public.exchange_bond_code('234567X.SH'),'2026-10-26',NULL,10,NULL),
      (public.exchange_bond_code('123456X.SH'),'2026-10-27',0,40,0);`);
    const before = (await db.query('SELECT * FROM bond_history ORDER BY valuation_date,bond_code')).rows;
    const observations = async (date: string) => (await db.query(`SELECT bond_code,valuation_date::text,chinabond_yield_pct,
      outstanding_balance_cny,remaining_term_years,raw_codes,conflict_fields
      FROM bond_history_observations(ARRAY[$1::date]) ORDER BY bond_code`, [date])).rows;
    expect(await observations('2026-10-19')).toHaveLength(2);
    expect(await observations('2026-10-26')).toEqual([
      { bond_code: 10123456, valuation_date: '2026-10-26', chinabond_yield_pct: 2, outstanding_balance_cny: 100,
        remaining_term_years: 3, raw_codes: [10123456,11123456,12123456], conflict_fields: [] },
      { bond_code: 11234567, valuation_date: '2026-10-26', chinabond_yield_pct: null, outstanding_balance_cny: 10,
        remaining_term_years: null, raw_codes: [11234567], conflict_fields: [] },
    ]);
    expect(await observations('2026-10-27')).toEqual([
      { bond_code: 10123456, valuation_date: '2026-10-27', chinabond_yield_pct: 0, outstanding_balance_cny: null,
        remaining_term_years: 0, raw_codes: [11123456], conflict_fields: [] },
    ]);
    expect((await db.query('SELECT * FROM bond_history ORDER BY valuation_date,bond_code')).rows).toEqual(before);
    await db.exec(`UPDATE bond_history SET chinabond_yield_pct=4,outstanding_balance_cny=40
      WHERE bond_code=public.exchange_bond_code('123456X.SH') AND valuation_date='2026-10-26'`);
    const conflict = (await observations('2026-10-26'))[0];
    expect(conflict).toMatchObject({ chinabond_yield_pct: null, outstanding_balance_cny: null,
      remaining_term_years: 3, conflict_fields: ['YIELDCNBD','BONDBALANCE'] });
    expect(await observations('2026-10-28')).toEqual([]);
  } finally { await db.close(); }
});

it('pins metadata and immutable evidence, shares daily coverage, and preserves frozen recovery request codes', async () => {
  const db = new PGlite();
  try {
    const directory = new URL('../edb-migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(name, directory), 'utf8'));
    }
    await db.exec(`INSERT INTO bond_issuance(bond_code,issue_date,issuer_name,maturity_date)
      VALUES('123456.SH','2025-01-01','测试证券','2030-01-01'),
      ('123456X.SH','2026-01-01','测试证券','2030-01-01'),
      ('123456X2.SH','2026-02-01','测试证券','2030-01-01');`);
    const rows = (await db.query(`SELECT bond_code,issue_date::text,maturity_date::text,issuer_name,
      short_name,interest_rate_type,bond_type,issue_amount_100m,final_coupon_pct FROM bond_issuance ORDER BY bond_code`)).rows;
    const facts = ['123456X.SH','123456X2.SH'].map(source_code => ({ source_code, canonical_code:'123456.SH',
      effective_from:'2026-10-20',official_file:'/private/listing.pdf',official_file_sha256:'a'.repeat(64),
      source_url:'https://example.com/listing.pdf',physical_pages:[2] }));
    const plan = { facts,metadata:rows,vendor_mapping_file:'/private/vendor.json',vendor_mapping_sha256:'b'.repeat(64) };
    const client = { query: async (sql: string, params?: unknown[]) => {
      const result = await db.query(sql, params); return { ...result,rowCount:result.affectedRows };
    } } as DatabaseClient;
    await expect(recordBondHistoryIdentities(client,{...plan,metadata:rows.slice(1)},'c'.repeat(64))).rejects.toThrow('endpoints');
    await db.exec('BEGIN');
    expect(await recordBondHistoryIdentities(client,plan,'c'.repeat(64))).toMatchObject({ missing:2,changed:0 });
    expect((await db.query('SELECT * FROM bond_history_identity')).rows).toEqual([]);
    expect(await recordBondHistoryIdentities(client,plan,'c'.repeat(64),true)).toMatchObject({ missing:2,changed:2 });
    expect(await recordBondHistoryIdentities(client,plan,'c'.repeat(64),true)).toMatchObject({ missing:0,changed:0 });
    await expect(recordBondHistoryIdentities(client,plan,'d'.repeat(64),true)).rejects.toThrow('refusing overwrite');
    await db.exec('COMMIT');
    await db.exec(`INSERT INTO bond_history VALUES
      (public.exchange_bond_code('123456.SH'),'2026-10-26',2,100,3),
      (public.exchange_bond_code('123456X.SH'),'2026-10-26',NULL,100,NULL),
      (public.exchange_bond_code('123456X2.SH'),'2026-10-26',NULL,100,NULL);`);
    const paid: string[][] = [];
    const request = async (path: string, parameters: URLSearchParams) => {
      if (path==='/choice/data-statistics') return { function:'DATASTATISTICS',rows:[{
        FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-10-26',ENDDATE:'2026-11-01',AVAILABEDATA:1000000,
      }] };
      const codes=parameters.get('codes')!.split(',');paid.push(codes);
      return { function:'CSS',rows:codes.map(code=>({code,YIELDCNBD:2,BONDBALANCE:100,MATUCNBD:3})) };
    };
    const database = async <T>(operation: (value: DatabaseClient) => Promise<T>) => operation(client);
    expect((await syncBondHistory(request,database,'2026-10-27',['2026-10-26'])).missing).toEqual([]);
    expect(paid).toEqual([]);
    expect((await db.query(`SELECT chinabond_yield_pct,remaining_term_years FROM bond_history
      WHERE bond_code=public.exchange_bond_code('123456X.SH')`)).rows).toEqual([{ chinabond_yield_pct:null,remaining_term_years:null }]);
    const daily=await syncBondHistory(request,database,'2026-10-28',['2026-10-27']);
    expect(paid).toEqual([['123456.SH']]);expect(daily.stored).toBe(1);expect(daily.missing).toEqual([]);
    const recovery=await syncBondHistory(request,database,'2026-10-29',['2026-10-28'],'2026-10-29',
      ['123456X.SH'],[{date:'2026-10-28',code:'123456X.SH'}]);
    expect(paid).toEqual([['123456.SH'],['123456X.SH']]);
    expect(recovery.missing).toEqual([{source:'bond-history',dates:['2026-10-28'],codes:['123456.SH'],
      fields:['BONDBALANCE'],reason:'stored_fields_incomplete'}]);
    const completed=await syncBondHistory(request,database,'2026-10-29',['2026-10-28']);
    expect(paid).toEqual([['123456.SH'],['123456X.SH'],['123456.SH']]);
    expect(completed.missing).toEqual([]);
    await db.exec(`UPDATE bond_history SET chinabond_yield_pct=9 WHERE
      bond_code=public.exchange_bond_code('123456X.SH') AND valuation_date='2026-10-26'`);
    const conflict=await syncBondHistory(request,database,'2026-10-27',['2026-10-26']);
    expect(conflict.missing).toEqual([{source:'bond-history',dates:['2026-10-26'],codes:['123456.SH'],
      fields:['YIELDCNBD'],reason:'source_value_conflict'}]);
    expect(paid).toHaveLength(3);
  } finally { await db.close(); }
});
