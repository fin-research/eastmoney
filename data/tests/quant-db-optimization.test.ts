import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { syncBondHistory } from '../src/sync/bond-history-sync.ts';
import type { DatabaseClient } from '../src/sync/postgres.ts';

describe('compact quant input migration', () => {
  it('refuses to discard text observations', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE public.quant_input (
        field text NOT NULL, observation_date date NOT NULL,
        numeric_value double precision, text_value text, published_date date,
        PRIMARY KEY (field, observation_date));
        INSERT INTO public.quant_input (field, observation_date, text_value)
        VALUES ('legacy_text', '2026-09-01', 'keep');`);
      const sql = await readFile(new URL('../edb-migrations/0011_numeric_only_quant_input.sql', import.meta.url), 'utf8');
      await expect(db.exec(sql)).rejects.toThrow('quant_input still contains text values');
      const preserved = await db.query<{ text_value: string }>('SELECT text_value FROM public.quant_input');
      expect(preserved.rows[0]?.text_value).toBe('keep');
    } finally { await db.close(); }
  });

  it('preserves issue facts in columns, resolves report overlaps and encodes exchange bonds', async () => {
    const db = new PGlite();
    try {
      const migration = async (name: string) => db.exec(await readFile(new URL(`../edb-migrations/${name}`, import.meta.url), 'utf8'));
      for (const name of ['0004_quant_inputs.sql', '0006_bond_research_inputs.sql',
        '0007_bond_research_observations_only.sql', '0008_restore_bond_date_indexes.sql',
        '0009_bond_observation_vintages.sql']) await migration(name);
      await db.exec(`INSERT INTO public.bond_issuance
        (bond_code,issue_date,issuer_name,source_record_count,source_last_synced_at)
        VALUES ('654321X2.SH','2026-09-01','测试证券',3,now());
        INSERT INTO public.quant_input
        (dataset,entity_key,field,observation_date,numeric_value,text_value,source,source_key,source_hash)
        VALUES
        ('issue','654321X2.SH','ISSUER_NAME','2026-09-01',null,'测试证券','choice','a','h'),
        ('issue','654321X2.SH','ISSCORPCREDITRAT','2026-09-01',null,'AAA','choice','a','h'),
        ('issue','654321X2.SH','PAYPERYEAR','2026-09-01',2,null,'choice','a','h'),
        ('issue','654321X2.SH','RAISEWAY','2026-09-01',null,'公募','choice','a','h'),
        ('issue','654321X2.SH','MATURITYDATE','2026-09-01',null,'2029-09-01','choice','a','h'),
        ('company','','lcr','2026-09-01',1.2,null,'workbook','a','h'),
        ('company_report','','lcr','2026-09-01',1.5,null,'report','b','h'),
        ('company','','nsfr','2026-09-01',1.3,null,'workbook','a','h');
        INSERT INTO public.bond_history(bond_code,valuation_date,chinabond_yield_pct)
        VALUES ('654321X2.SH','2026-09-01',2.1),('123456.SZ','2026-09-01',2.2),('091900012.IB','2026-09-01',2.3);`);
      await migration('0010_compact_quant_inputs.sql');
      await migration('0011_numeric_only_quant_input.sql');
      const bonds = await db.query<{ bond_code: number }>('SELECT bond_code FROM public.bond_history ORDER BY bond_code');
      expect(bonds.rows.map(row => Number(row.bond_code))).toEqual([12654321, 20123456]);
      const issue = await db.query<{ issuance_rating: string; pay_per_year: number; placement_type: string; maturity_date: string }>(
        "SELECT issuance_rating,pay_per_year,placement_type,maturity_date::text FROM public.bond_issuance WHERE bond_code='654321X2.SH'");
      expect(issue.rows[0]).toEqual({ issuance_rating: 'AAA', pay_per_year: 2,
        placement_type: '公募', maturity_date: '2029-09-01' });
      const input = await db.query<{ field: string; numeric_value: number }>('SELECT field,numeric_value FROM public.quant_input ORDER BY field');
      expect(input.rows).toEqual([{ field: 'lcr', numeric_value: 1.5 }, { field: 'nsfr', numeric_value: 1.3 }]);
      const columns = await db.query<{ column_name: string; is_nullable: string }>(`SELECT column_name,is_nullable
        FROM information_schema.columns WHERE table_schema='public' AND table_name='quant_input'`);
      expect(columns.rows.find(row => row.column_name === 'text_value')).toBeUndefined();
      expect(columns.rows.find(row => row.column_name === 'numeric_value')?.is_nullable).toBe('NO');
      const absent = await db.query<{ name: string }>(`SELECT to_regclass('public.bond_history_request')::text AS name`);
      expect(absent.rows[0]?.name).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('ingests only missing exchange bond-days without a request table', async () => {
    const db = new PGlite();
    try {
      for (const name of ['0004_quant_inputs.sql', '0006_bond_research_inputs.sql',
        '0007_bond_research_observations_only.sql', '0008_restore_bond_date_indexes.sql',
        '0009_bond_observation_vintages.sql', '0010_compact_quant_inputs.sql',
        '0011_numeric_only_quant_input.sql', '0012_bond_css_invalid_codes.sql', '0013_bond_actual_issuance_status.sql',
        '0014_bond_history_identity.sql']) {
        await db.exec(await readFile(new URL(`../edb-migrations/${name}`, import.meta.url), 'utf8'));
      }
      await db.exec(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name)
        VALUES('123456.SH','2026-01-01','测试证券');
        INSERT INTO public.bond_industry_curve(curve_code,curve_name,observation_date,tenor_years,yield_pct)
        VALUES('curve','测试','2026-09-28',3,2.1);`);
      const client = { query: async (...args: Parameters<typeof db.query>) => {
        const result = await db.query(...args); return { ...result, rowCount: result.affectedRows };
      } };
      let paid = 0;
      const request = async (path: string) => path.endsWith('/data-statistics')
        ? { function: 'DATASTATISTICS', rows: [{ FUNCENAME: 'EM_CSS', SECUTYPE: '全品种',
          PERIOD: 'W', STARTDATE: '2026-10-12', ENDDATE: '2026-10-18', AVAILABEDATA: 200000 }] }
        : (paid++, { function: 'CSS', rows: [{ code: '123456.SH', YIELDCNBD: 2.2,
          BONDBALANCE: 100000000, MATUCNBD: 2.5 }] });
      const wrapper = <T>(operation: (database: DatabaseClient) => Promise<T>) => operation(client as unknown as DatabaseClient);
      const blocked = await syncBondHistory(request, wrapper, '2026-09-29', ['2026-09-28']);
      expect(blocked.failures[0]).toMatchObject({kind:'execution',error:'Bond CSS quota unavailable or below shared reserve'});
      expect(blocked.missing).toContainEqual(expect.objectContaining({dates:['2026-09-28'],codes:['123456.SH'],reason:'observation_absent'}));
      expect(paid).toBe(0);
      const first = await syncBondHistory(request, wrapper, '2026-09-29', ['2026-09-28'], '2026-10-13');
      const second = await syncBondHistory(request, wrapper, '2026-09-29', ['2026-09-28']);
      expect(first.stored).toBe(1);
      expect(second.stored).toBe(0);
      expect(paid).toBe(1);
      const rows = await db.query<{bond_code:number}>('SELECT bond_code FROM public.bond_history');
      expect(rows.rows[0]?.bond_code).toBe(10123456);
    } finally { await db.close(); }
  });
});
