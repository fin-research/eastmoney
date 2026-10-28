import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { Client } from 'pg';
import { pricingInputs } from '../src/sync/quant-pricing.ts';
import { updateBondPricing } from '../src/sync/bond-issuance-repository.ts';

const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
if (!args.includes('--file') || !file) throw new Error('--file <issuance_pricing_metadata.csv> required');
const bytes = await readFile(file);
const hash = createHash('sha256').update(bytes).digest('hex');
const book = XLSX.read(bytes, { type: 'buffer', raw: true });
const records = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets[book.SheetNames[0]!]!, { defval: '' });
const codes = records.map(row => row.bond_code?.toUpperCase());
if (codes.some(code => !code) || new Set(codes).size !== codes.length) throw new Error('Missing or duplicate pricing codes');
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 20000, query_timeout: 60000 });
try {
  await client.connect();
  const dates = await client.query<{code: string; date: string}>(`SELECT bond_code AS code, issue_date::text AS date
    FROM public.bond_issuance WHERE bond_code=ANY($1::text[])`, [codes]);
  if (new Set(dates.rows.map(row => row.code)).size !== dates.rows.length) throw new Error('Conflicting issuance dates');
  const byCode = new Map(dates.rows.map(row => [row.code, row.date]));
  const eligible = records.filter(row => /\.(SH|SZ)$/.test(row.bond_code!.toUpperCase()));
  const unmatched = eligible.filter(row => !byCode.has(row.bond_code!.toUpperCase()));
  if (unmatched.length) throw new Error(`${unmatched.length} exchange bonds lack issuance dates; backfill issue facts first`);
  const rows = eligible.flatMap(row => pricingInputs({code: row.bond_code!.toUpperCase(), date: byCode.get(row.bond_code!.toUpperCase())!}, {
    TENDERDATE: row.pricing_date, TENDERFINALCOUPON: row.final_coupon,
    ISSCORPCREDITRAT: row.issuance_rating, TENDERANNCDATE: row.announcement_date,
  }, hash, 'choice-metadata-cache', 'issuance-pricing-metadata.csv'));
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', codes: eligible.length,
    fields: rows.length, quarantinedFields: rows.filter(row => row.dataset === 'issue_pricing_quarantine').length, sourceHash: hash }));
  if (args.includes('--apply')) {
    let count = 0;
    for (const code of eligible.map(row => row.bond_code!.toUpperCase())) {
      const values = rows.filter(row => row.entityKey === code);
      const fields = Object.fromEntries(values.map(row => [row.field, row.numericValue ?? row.textValue]));
      if (!values.length) continue;
      const quarantine = values.some(row => row.dataset === 'issue_pricing_quarantine');
      count += await updateBondPricing(client, code, fields, quarantine);
    }
    console.log(JSON.stringify({ inserted: count }));
  }
} finally { await client.end(); }
