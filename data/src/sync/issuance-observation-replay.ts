import { listObservationKeys, readObservation, readLiveObservationManifest, saveApplicationReceipt, type ObservationBucket } from './issuance-observation-store.ts';
import type { DatabaseClient } from './postgres.ts';
import { fetchQuantMarketInputs, quantMarketRequests } from './quant-market-sync.ts';
import { upsertBondIssuance } from './bond-issuance-repository.ts';
import { fetchIssuePricing, persistPricingRows, pricingDate } from './quant-pricing.ts';
import { applyPlacementResponse } from './bond-placement-sync.ts';
import type { ObservationRequest, ObservationPayload } from './issuance-observation-contract.ts';
import { canonical } from './issuance-observation-contract.ts';

type Database = <T>(operation: (client: DatabaseClient) => Promise<T>) => Promise<T>;
type ApplyStats = { stored: number; inserted_bonds: number; skipped_existing_bonds: number; filled_fields: number;
  preserved_fields: number; conflicting_fields: number | null; absent_bonds: number; quarantined_bonds: number; context_conflicts: number;
  missing_fields: Array<{ code: string; fields: string[] }> };
const emptyStats = (): ApplyStats => ({ stored: 0, inserted_bonds: 0, skipped_existing_bonds: 0, filled_fields: 0,
  preserved_fields: 0, conflicting_fields: 0, absent_bonds: 0, quarantined_bonds: 0, context_conflicts: 0, missing_fields: [] });
const pricingColumns: Record<string,string> = { TENDERDATE: 'tender_date', TENDERFINALCOUPON: 'final_coupon_pct',
  ISSCORPCREDITRAT: 'issuance_rating', TENDERANNCDATE: 'tender_announcement_date' };

/** Administrative recovery only: every source is a validated archived response, never an upstream request. */
export async function replayIssuanceObservations(bucket: ObservationBucket, db: Database, originalInstance: string, replayInstance: string) {
  const keys = await listObservationKeys(bucket,originalInstance);
  if (!keys.length) throw new Error('No archived issuance observations for original instance');
  let manifest: Awaited<ReturnType<typeof readLiveObservationManifest>> = null;
  try { manifest = await readLiveObservationManifest(bucket,originalInstance); } catch { /* Unknown request universe remains explicit. */ }
  const requestSetVerified = !!manifest && manifest.requests.every(r => r.status === 'archived' && keys.includes(r.key))
    && keys.every(key => manifest!.requests.some(r => r.key === key));
  const applications: Array<{ key: string; source?: string; status: string; stats?: ApplyStats; outcome?: string; missing_codes?: string[] }> = [];
  const observations: Array<Awaited<ReturnType<typeof readObservation>>> = [];
  for (const key of keys) {
    try { observations.push(await readObservation(bucket,originalInstance,key)); }
    catch { applications.push({ key, status: 'invalid_archive' }); continue; }
  }
  observations.sort((a,b) => Number(a.record.request.source !== 'issue-detail') - Number(b.record.request.source !== 'issue-detail')
    || a.record.response_received_at.localeCompare(b.record.response_received_at) || a.key.localeCompare(b.key));
  for (const observation of observations) {
    const key = observation.key;
    const { record, content } = observation, source = record.request.source;
    if (content.kind !== 'response') {
      const terminalGap = content.kind === 'no_data' ? source !== 'issue-detail'
        : content.kind === 'invalid_code' ? record.request.bonds.length === 1 : true;
      const unresolved = content.kind === 'invalid_code' && !terminalGap && !splitCovered(observation,observations);
      applications.push({ key, source, status: terminalGap ? 'unrecovered_source' : unresolved ? 'unresolved_split' : 'skipped_failed_source', outcome: content.kind }); continue;
    }
    const quality = observation.quality!;
    if (quality.duplicate_codes.length || quality.rows.some(row => row.unexpected_code)) {
      applications.push({ key, source, status: 'invalid_response_codes' }); continue;
    }
    try {
      const stats = await applyObservation(db,record.request,content.payload,record.scheduled_date);
      applications.push({ key, source, status: stats.absent_bonds || stats.context_conflicts || stats.quarantined_bonds || stats.missing_fields.length ? 'partial' : 'applied',
        stats, missing_codes: quality.missing_codes });
    } catch { applications.push({ key, source, status: 'database_failed' }); }
  }
  const applicationStatus = applications.some(a => ['invalid_archive','invalid_response_codes','database_failed'].includes(a.status)) ? 'partial' : 'complete';
  const coverageStatus = !requestSetVerified || applicationStatus !== 'complete' ? 'unknown'
    : applications.some(a => ['partial','unrecovered_source','unresolved_split'].includes(a.status)) ? 'partial' : 'complete';
  const status = applicationStatus === 'complete' && coverageStatus === 'complete' ? 'complete' : 'partial';
  const receipt = await saveApplicationReceipt(bucket,replayInstance,{ mode: 'replay', original_instance: originalInstance,
    status, application_status: applicationStatus, coverage_status: coverageStatus, request_set_verified: requestSetVerified, applications, paid_requests: 0 });
  return { status, application_status: applicationStatus, coverage_status: coverageStatus, request_set_verified: requestSetVerified,
    application_receipt: receipt, applications, paid_requests: 0 };
}

async function applyObservation(db: Database, request: ObservationRequest, payload: ObservationPayload, checkedDate: string): Promise<ApplyStats> {
  const stats = emptyStats();
  if (request.source === 'issue-detail') {
    const options = request.parameters.options!, start = options.match(/(?:^|,)StartDate=([^,]+)/)?.[1], end = options.match(/(?:^|,)EndDate=([^,]+)/)?.[1];
    if (!start || !end) throw new Error('Missing original issuance query range');
    const spec = quantMarketRequests(start,end).find(s => s.dataset === 'issue')!;
    // Stored request parameters, rather than today's query, govern reconstruction.
    const rows = await fetchQuantMarketInputs(async()=>payload,{ ...spec, parameters: request.parameters },start,end);
    const codes = [...new Set(rows.map(r => r.entityKey.toUpperCase()))];
    await db(async client => {
      const existing = await client.query('SELECT bond_code FROM public.bond_issuance WHERE bond_code=ANY($1::text[])',[codes]);
      stats.skipped_existing_bonds = existing.rows.length;
      stats.stored = await upsertBondIssuance(client,rows,true);
    });
    stats.inserted_bonds = stats.stored;
    stats.conflicting_fields = null; // Existing CTR rows are wholly skipped, not compared or overwritten.
    return stats;
  }
  await db(async client => {
    await client.query('BEGIN');
    try {
      const before = await client.query<Record<string,unknown>>(`SELECT bond_code,issue_date::text,
        tender_date::text,final_coupon_pct,issuance_rating,tender_announcement_date::text,
        quarantine_tender_date,quarantine_final_coupon_pct,quarantine_issuance_rating,quarantine_announcement_date,
        placement_type,maturity_date::text FROM public.bond_issuance WHERE bond_code=ANY($1::text[]) FOR UPDATE`,[request.bonds.map(b=>b.code)]);
      const existing = new Map(before.rows.map(r=>[String(r.bond_code),r]));
      const consistent = request.bonds.filter(bond => {
        const current = existing.get(bond.code);
        if (!current) { stats.absent_bonds++; return false; }
        if (current.issue_date !== bond.date) { stats.context_conflicts++; return false; }
        return true;
      });
      const consistentCodes = new Set(consistent.map(b => b.code));
      const response = { ...payload, rows: payload.rows.filter(row => consistentCodes.has(String(row.code).toUpperCase())) };
      if (request.source === 'issue-pricing') {
        const { rows } = await fetchIssuePricing(async()=>response,consistent);
        for (const bond of consistent) {
          const incoming = rows.filter(r=>r.entityKey===bond.code);
          if (!incoming.length) continue;
          const current = existing.get(bond.code);
          if (!current) { stats.absent_bonds++; continue; }
          const quarantined = incoming.some(r=>r.dataset==='issue_pricing_quarantine');
          if (quarantined) stats.quarantined_bonds++;
          for (const row of incoming) {
            const raw = row.numericValue ?? row.textValue;
            const value = ['TENDERDATE','TENDERANNCDATE'].includes(row.field) && !quarantined ? pricingDate(raw) : raw;
            const column = quarantined ? ({ TENDERDATE:'quarantine_tender_date',TENDERFINALCOUPON:'quarantine_final_coupon_pct',ISSCORPCREDITRAT:'quarantine_issuance_rating',TENDERANNCDATE:'quarantine_announcement_date' }[row.field]) : pricingColumns[row.field];
            countField(stats,current[column!],value,row.field==='TENDERFINALCOUPON');
          }
        }
        stats.stored = await persistPricingRows(client,consistent,rows);
      } else {
        for (const row of response.rows) {
          const current = existing.get(String(row.code).toUpperCase());
          if (!current) { stats.absent_bonds++; continue; }
          countField(stats,current.placement_type,['公募','私募'].includes(String(row.RAISEWAY)) ? row.RAISEWAY : null);
          countField(stats,current.maturity_date,pricingDate(row.MATURITYDATE));
        }
        stats.stored = await applyPlacementResponse(operation=>operation(client),Object.fromEntries(consistent.map(b=>[b.code,b.date])),response,checkedDate);
      }
      const columns = request.source === 'issue-pricing' ? Object.values(pricingColumns) : ['placement_type','maturity_date'];
      const after = await client.query<Record<string,unknown>>(`SELECT bond_code,${columns.join(',')} FROM public.bond_issuance
        WHERE bond_code=ANY($1::text[])`,[request.bonds.map(b=>b.code)]);
      for (const bond of request.bonds) {
        const row = after.rows.find(r=>r.bond_code===bond.code);
        const fields = columns.filter(c => row?.[c] == null || row[c] === '');
        if (fields.length) stats.missing_fields.push({ code: bond.code, fields });
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
  });
  return stats;
}
function countField(stats: ApplyStats, current: unknown, incoming: unknown, numeric = false) {
  if (incoming == null || incoming === '' || (numeric && !Number.isFinite(Number(incoming)))) return;
  if (current == null) stats.filled_fields++;
  else {
    stats.preserved_fields++;
    if (numeric ? Number(current) !== Number(incoming) : String(current) !== String(incoming)) stats.conflicting_fields!++;
  }
}

function splitCovered(parent: Awaited<ReturnType<typeof readObservation>>, observations: Array<Awaited<ReturnType<typeof readObservation>>>) {
  const request = parent.record.request;
  const parameters = (r: ObservationRequest) => canonical({ ...r.parameters, codes: '' });
  const codes = request.bonds.map(b=>b.code), covered = new Set<string>();
  for (const child of observations) {
    const r = child.record.request;
    if (r.source !== request.source || parameters(r) !== parameters(request) || r.bonds.length >= codes.length
        || r.bonds.some(b=>!request.bonds.some(p=>p.code===b.code && p.date===b.date))) continue;
    if (child.content.kind === 'response' || (child.content.kind === 'invalid_code' && r.bonds.length === 1)) {
      r.bonds.forEach(b=>covered.add(b.code));
    }
  }
  return codes.every(code=>covered.has(code));
}
