import { z } from 'zod';
import { encodeExchangeBondCode } from './exchange-bond-code.ts';
import type { DatabaseClient } from './postgres.ts';
const digest=z.string().regex(/^[0-9a-f]{64}$/);
export const issuanceSourceFact=z.object({
  code:z.string().refine(value=>{try{encodeExchangeBondCode(value);return value===value.trim().toUpperCase();}catch{return false;}},'Unsupported exchange bond code'), status:z.enum(['issued','not_issued']),
  issueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),tenorYears:z.number().positive(),
  batch:z.string().min(1),issuerName:z.string().min(1),shortName:z.string().min(1),reviewSha256:digest,
  sourceUrl:z.string().url().startsWith('https://'),sourceSha256:digest,
  announcementDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),physicalPage:z.number().int().positive(),
});
export type IssuanceSourceFact=z.infer<typeof issuanceSourceFact>;

/** Caller verifies approved review and local PDF hashes. No model or quote fields are updated. */
export async function recordIssuanceSourceFact(client:DatabaseClient,value:unknown,apply=false) {
  const fact=issuanceSourceFact.parse(value);
  const result=await client.query<Record<string,unknown>>('SELECT *,issue_date::text AS issue_date,actual_issuance_announcement_date::text AS actual_issuance_announcement_date FROM public.bond_issuance WHERE bond_code=$1 FOR UPDATE',[fact.code]);
  const row=result.rows[0];
  if(result.rows.length!==1||row!.issue_date==null||String(row!.issue_date instanceof Date?row!.issue_date.toISOString().slice(0,10):row!.issue_date)!==fact.issueDate||
    Number(row!.original_tenor_years)!==fact.tenorYears||row!.issuer_name!==fact.issuerName||row!.short_name!==fact.shortName)
    throw Error('Source fact does not match current code/date/tenor/issuer/tranche');
  if(row!.actual_issuance_status!=='unknown') {
    if(row!.actual_issuance_status!==fact.status||row!.actual_issuance_source_url!==fact.sourceUrl||row!.actual_issuance_source_sha256!==fact.sourceSha256||
      String(row!.actual_issuance_announcement_date instanceof Date?row!.actual_issuance_announcement_date.toISOString().slice(0,10):row!.actual_issuance_announcement_date)!==fact.announcementDate)
      throw Error('Existing issuance source fact conflicts; refusing overwrite');
    return {mode:apply?'apply':'dry-run',changed:0,code:fact.code,status:fact.status};
  }
  if(apply) await client.query(`UPDATE public.bond_issuance SET actual_issuance_status=$2,
    actual_issuance_source_url=$3,actual_issuance_source_sha256=$4,actual_issuance_announcement_date=$5::date,
    actual_issuance_recorded_at=clock_timestamp() WHERE bond_code=$1`,
    [fact.code,fact.status,fact.sourceUrl,fact.sourceSha256,fact.announcementDate]);
  return {mode:apply?'apply':'dry-run',changed:apply?1:0,code:fact.code,status:fact.status};
}
