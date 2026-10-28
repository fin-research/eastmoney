import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

describe('separate bond research inputs', () => {
  it('projects primary facts without treating a reference rate as a final coupon', async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL('../edb-migrations/0004_quant_inputs.sql', import.meta.url), 'utf8'));
      await db.exec(await readFile(new URL('../edb-migrations/0006_bond_research_inputs.sql', import.meta.url), 'utf8'));
      await db.exec(await readFile(new URL('../edb-migrations/0007_bond_research_observations_only.sql', import.meta.url), 'utf8'));
      const fields = [
        ['ISSUER_NAME', null, '某证券股份有限公司'],
        ['BOND_TYPE', null, '证券公司债'],
        ['IS_OEB', null, '否'],
        ['TENOR_YEAR', 3, null],
        ['ISSUERATE_REFERENCE', 1.82, null],
        ['TENDERDATE', null, '2026/9/10'],
      ];
      for (const [field, numeric, value] of fields) {
        await db.query(`INSERT INTO public.quant_input
          (dataset,entity_key,field,observation_date,numeric_value,text_value,source,source_key,source_hash)
          VALUES ('issue','123456.SH',$1,'2026-09-10',$2,$3,'test','test','hash')`, [field, numeric, value]);
      }
      const first = await db.query<{changed: string}>('SELECT public.refresh_bond_issuance_from_quant_input(NULL) AS changed');
      expect(Number(first.rows[0]?.changed)).toBe(1);
      const record = await db.query<{final_coupon_pct: number | null; coupon_reference_pct: number; has_option: boolean; tender_date: string}>(
        'SELECT final_coupon_pct,coupon_reference_pct,has_option,tender_date::text FROM public.bond_issuance');
      expect(record.rows[0]).toMatchObject({final_coupon_pct: null, coupon_reference_pct: 1.82, has_option: false, tender_date: '2026-09-10'});
      const second = await db.query<{changed: string}>('SELECT public.refresh_bond_issuance_from_quant_input(NULL) AS changed');
      expect(Number(second.rows[0]?.changed)).toBe(0);
      await db.query(`INSERT INTO public.quant_input
        (dataset,entity_key,field,observation_date,numeric_value,source,source_key,source_hash)
        VALUES ('issue','123456.SH','TENDERFINALCOUPON','2026-09-10',1.86,'test','test','hash')`);
      const third = await db.query<{changed: string}>('SELECT public.refresh_bond_issuance_from_quant_input(ARRAY[\'123456.SH\']) AS changed');
      expect(Number(third.rows[0]?.changed)).toBe(1);
      const after = await db.query<{final_coupon_pct: number}>('SELECT final_coupon_pct FROM public.bond_issuance');
      expect(after.rows[0]?.final_coupon_pct).toBe(1.86);
      await db.query(`INSERT INTO public.bond_history
        (bond_code,valuation_date,chinabond_yield_pct)
        VALUES ('123456.SH','2026-09-11',1.84)`);
      const history = await db.query<{outstanding_balance_cny: number | null}>('SELECT outstanding_balance_cny FROM public.bond_history');
      expect(history.rows[0]?.outstanding_balance_cny).toBeNull();
      const columns = await db.query<{table_name: string; column_name: string}>(`
        SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('bond_history','bond_industry_curve')
        ORDER BY table_name,ordinal_position`);
      expect(columns.rows.filter(row => row.table_name === 'bond_history').map(row => row.column_name)).toEqual([
        'bond_code','valuation_date','chinabond_yield_pct','outstanding_balance_cny','remaining_term_years',
      ]);
      expect(columns.rows.filter(row => row.table_name === 'bond_industry_curve').map(row => row.column_name)).toEqual([
        'curve_code','curve_name','observation_date','tenor_years','yield_pct','node_label',
      ]);
    } finally {
      await db.close();
    }
  });

  it('restores date indexes when the recorded bond migration left them missing', async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL('../edb-migrations/0004_quant_inputs.sql', import.meta.url), 'utf8'));
      await db.exec(await readFile(new URL('../edb-migrations/0006_bond_research_inputs.sql', import.meta.url), 'utf8'));
      await db.exec(await readFile(new URL('../edb-migrations/0007_bond_research_observations_only.sql', import.meta.url), 'utf8'));
      await db.exec('DROP INDEX public.bond_history_date_idx; DROP INDEX public.bond_industry_curve_date_idx;');
      const repair = await readFile(new URL('../edb-migrations/0008_restore_bond_date_indexes.sql', import.meta.url), 'utf8');
      await db.exec(repair);
      await db.exec(repair);
      const indexes = await db.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND indexname IN ('bond_history_date_idx', 'bond_industry_curve_date_idx')
        ORDER BY indexname`);
      expect(indexes.rows.map(row => row.indexname)).toEqual([
        'bond_history_date_idx', 'bond_industry_curve_date_idx',
      ]);
      expect(indexes.rows[0]?.indexdef).toContain('(valuation_date DESC, bond_code)');
      expect(indexes.rows[1]?.indexdef).toContain('(observation_date DESC, curve_code)');
    } finally {
      await db.close();
    }
  });
});
