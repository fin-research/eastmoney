import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { historicalCells, historicalRows, insertHistoricalBonds, verifyHistoricalReview, type HistoryRequest } from '../src/sync/bond-history-restoration.ts';

const request: HistoryRequest = { date: '2019-01-21', codes: ['112840.SZ'],
  indicators: ['YIELDCNBD', 'BONDBALANCE', 'MATUCNBD'], options: 'EndDate=2019-01-21,CredType=1,Ispandas=1' };
const raw = { function: 'CSS', rows: [{ code: '112840.SZ', YIELDCNBD: 3.4675, BONDBALANCE: 2200000000, MATUCNBD: 2.9863 }] };
describe('controlled historical bond restoration', () => {
  it('binds reviewed rows and source identity, permits explicit NULL but refuses unknown or failed cells', () => {
    const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const rows = '[]';
    const current = {assembledAt:'2026-10-23T02:00:00Z',failures:[] as unknown[],unknownRows:0,
      stats:{'2019/YIELDCNBD':{failed:0,null:2}},sources:[{sha256:'original'}]};
    const approve = (manifest: typeof current) => {
      const reviewed = JSON.stringify(manifest);
      return () => verifyHistoricalReview({...manifest,assembledAt:'2026-10-23T03:00:00Z'},rows,reviewed,rows,sha(reviewed),sha(rows));
    };
    expect(approve(current)).not.toThrow();
    expect(approve({...current,unknownRows:1})).toThrow('incomplete');
    expect(approve({...current,failures:[{index:1}]})).toThrow('incomplete');
    expect(approve({...current,stats:{'2019/YIELDCNBD':{failed:1,null:0}}})).toThrow('incomplete');
    const reviewed = JSON.stringify(current);
    expect(() => verifyHistoricalReview({...current,sources:[{sha256:'changed'}]},rows,reviewed,rows,sha(reviewed),sha(rows))).toThrow('changed');
    expect(() => verifyHistoricalReview(current,'[{}]',reviewed,rows,sha(reviewed),sha(rows))).toThrow('changed');
    expect(() => verifyHistoricalReview(current,rows,reviewed,rows,'0'.repeat(64),sha(rows))).toThrow('changed');
  });
  it('retains raw CNY and historical term, counts NULL and failed fields separately', () => {
    const cells = historicalCells(raw, request);
    const output = historicalRows([{ date: request.date, codes: ['112840.SZ', '151105.SH'] }], cells);
    expect(output.rows[0]).toMatchObject({ chinabond_yield_pct: 3.4675, outstanding_balance_cny: 2200000000, remaining_term_years: 2.9863 });
    expect(output.stats['2019/YIELDCNBD']).toEqual({ requested: 2, valid: 1, null: 0, failed: 1 });
    const nulls = historicalCells({ function: 'CSS', rows: [{code: '112840.SZ', YIELDCNBD: null, BONDBALANCE: null, MATUCNBD: null}] }, request);
    const absent = historicalRows([{date: request.date, codes: request.codes}], nulls);
    expect(absent.rows).toEqual([]);
    expect(absent.stats['2019/BONDBALANCE']).toEqual({requested: 1, valid: 0, null: 1, failed: 0});
  });
  it('rejects absent/duplicate rows, missing fields and numeric strings rather than inventing NULL', () => {
    expect(() => historicalCells({function:'CSS',rows:[]},request)).toThrow('Incomplete');
    expect(() => historicalCells({function:'CSS',rows:[{...raw.rows[0],code:'000001.SZ'}]},request)).toThrow('code');
    expect(() => historicalCells({function:'CSS',rows:[{code:'112840.SZ'}]},request)).toThrow('value');
    expect(() => historicalCells({function:'CSS',rows:[{...raw.rows[0],BONDBALANCE:'22'}]},request)).toThrow('value');
  });
  it('uses one transaction and refuses any concurrently added before-image without overwriting it', async () => {
    const db = new PGlite();
    await db.exec(`CREATE TABLE bond_history (bond_code integer,valuation_date date,chinabond_yield_pct double precision,
      outstanding_balance_cny double precision,remaining_term_years double precision,PRIMARY KEY(bond_code,valuation_date));`);
    const client = {query:async(sql:string,values?:unknown[]) => {const r=await db.query(sql,values);return {rows:r.rows,rowCount:r.affectedRows};}};
    const rows = historicalRows([{date:request.date,codes:request.codes}],historicalCells(raw,request)).rows;
    const matrix = [{date:request.date,codes:request.codes}];
    try {
      expect(await insertHistoricalBonds(client as never,rows,matrix)).toEqual({inserted:1});
      await expect(insertHistoricalBonds(client as never,rows,matrix)).rejects.toThrow('before-image');
      expect((await db.query('SELECT * FROM bond_history')).rows).toHaveLength(1);
      await expect(insertHistoricalBonds(client as never,[{...rows[0]!,valuation_date:'2019-01-22'}],
        matrix)).rejects.toThrow('scope');
      const broken = [{...rows[0]!,valuation_date:'2019-01-22'}, {...rows[0]!,valuation_date:'2019-01-22'}];
      await expect(insertHistoricalBonds(client as never,broken,[{date:'2019-01-22',codes:request.codes}])).rejects.toThrow('duplicate');
      expect((await db.query('SELECT * FROM bond_history')).rows).toHaveLength(1);
    } finally {await db.close();}
  });
});
