import { z } from 'zod';
import { decodeExchangeBondCode, encodeExchangeBondCode } from './exchange-bond-code.ts';
import type { DatabaseClient } from './postgres.ts';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const code = z.string().refine(value => {
  try { return decodeExchangeBondCode(encodeExchangeBondCode(value)) === value; }
  catch { return false; }
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const metadata = z.object({
  bond_code: code, issue_date: date, maturity_date: date.nullable(), issuer_name: z.string(),
  short_name: z.string().nullable(), interest_rate_type: z.string().nullable(),
  bond_type: z.string().nullable(), issue_amount_100m: z.number().nullable(),
  final_coupon_pct: z.number().nullable(),
});
export const bondHistoryIdentityPlan = z.object({
  vendor_mapping_file: z.string(), vendor_mapping_sha256: digest,
  facts: z.array(z.object({
    source_code: code, canonical_code: code, effective_from: date,
    official_file: z.string(), official_file_sha256: digest,
    source_url: z.string().url().startsWith('https://'), physical_pages: z.array(z.number().int().positive()).min(1),
  })).min(1),
  metadata: z.array(metadata).min(2),
});

export async function recordBondHistoryIdentities(client: DatabaseClient, input: unknown, reviewSha256: string, apply = false) {
  const plan = bondHistoryIdentityPlan.parse(input);
  digest.parse(reviewSha256);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bond-history-identity',0))");
  const sources = plan.facts.map(fact => fact.source_code);
  if (new Set(sources).size !== sources.length) throw Error('Duplicate identity source');
  const codes = [...new Set(plan.facts.flatMap(fact => [fact.source_code, fact.canonical_code]))].sort();
  const expected = new Map(plan.metadata.map(row => [row.bond_code, row]));
  if (expected.size !== plan.metadata.length || expected.size !== codes.length || codes.some(value => !expected.has(value))) {
    throw Error('Frozen metadata does not match identity endpoints');
  }
  const rows = await client.query<z.infer<typeof metadata>>(`SELECT bond_code,issue_date::text,maturity_date::text,issuer_name,
    short_name,interest_rate_type,bond_type,issue_amount_100m,final_coupon_pct FROM public.bond_issuance
    WHERE bond_code=ANY($1::text[]) ORDER BY bond_code FOR UPDATE`, [codes]);
  if (rows.rows.length !== codes.length || rows.rows.some(row =>
    Object.entries(expected.get(row.bond_code)!).some(([key, value]) => row[key as keyof typeof row] !== value))) {
    throw Error('Current issuance metadata differs from reviewed snapshot');
  }
  const existing = await client.query<Record<string, unknown>>(`SELECT source_code,canonical_code,effective_from::text,
    official_url,official_sha256,official_pages,vendor_mapping_sha256,review_sha256 FROM public.bond_history_identity`);
  const bySource = new Map(existing.rows.map(row => [String(row.source_code), row]));
  const targets = new Set(existing.rows.map(row => String(row.canonical_code)));
  for (const fact of plan.facts) {
    const source = expected.get(fact.source_code)!, target = expected.get(fact.canonical_code)!;
    if (fact.source_code === fact.canonical_code || bySource.has(fact.canonical_code) || sources.includes(fact.canonical_code) || targets.has(fact.source_code)) {
      throw Error('Identity target must be direct and final');
    }
    if (source.issue_date > fact.effective_from || target.issue_date > fact.effective_from ||
      ['issuer_name', 'maturity_date', 'interest_rate_type', 'bond_type'].some(key =>
        source[key as keyof typeof source] !== target[key as keyof typeof target])) {
      throw Error('Identity conflicts with issuance endpoints');
    }
  }
  let missing = 0;
  for (const fact of plan.facts) {
    const values = {
      source_code: fact.source_code, canonical_code: fact.canonical_code, effective_from: fact.effective_from,
      official_url: fact.source_url, official_sha256: fact.official_file_sha256, official_pages: fact.physical_pages,
      vendor_mapping_sha256: plan.vendor_mapping_sha256, review_sha256: reviewSha256,
    };
    const old = bySource.get(fact.source_code);
    if (old) {
      if (Object.entries(values).some(([key, value]) => JSON.stringify(old[key]) !== JSON.stringify(value))) {
        throw Error('Existing reviewed identity conflicts; refusing overwrite');
      }
      continue;
    }
    missing++;
    if (apply) await client.query(`INSERT INTO public.bond_history_identity
      (source_code,canonical_code,effective_from,official_url,official_sha256,official_pages,vendor_mapping_sha256,review_sha256)
      VALUES($1,$2,$3::date,$4,$5,$6::integer[],$7,$8)`, Object.values(values));
  }
  return { mode: apply ? 'apply' : 'dry-run', reviewed: plan.facts.length, missing, changed: apply ? missing : 0 };
}
