import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ISSUE_FIELDS, ISSUE_PRICING_FIELDS, sourceDate, pricingDate } from './quant-input-contract.ts';

export const OBSERVATION_PREFIX = 'data-observations/bond-issuance/';
export type ObservationSource = 'issue-detail' | 'issue-pricing' | 'bond-placement';
export type ObservationBond = { code: string; date: string };
export type BondRequestFactory = (bonds: ObservationBond[]) => import('./economic-indicator-sync.ts').DataApiRequest;
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const observationPayload = z.object({ function: z.enum(['CTR', 'CSS']), fields: z.array(z.string()),
  rows: z.array(z.record(z.string(), scalar)).max(20_000) });
export type ObservationPayload = z.infer<typeof observationPayload>;
export const observationRequest = z.object({ source: z.enum(['issue-detail', 'issue-pricing', 'bond-placement']),
  path: z.enum(['/choice/ctr', '/choice/css']), parameters: z.record(z.string(), z.string()),
  bonds: z.array(z.object({ code: z.string(), date: z.string() })) });
export type ObservationRequest = z.infer<typeof observationRequest>;

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export const observationHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function instancePrefix(instance: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instance)) throw new Error('Invalid observation instance');
  return `${OBSERVATION_PREFIX}${instance}/`;
}
export function observationDescriptor(path: string, query: URLSearchParams, bonds: ObservationBond[] = []): ObservationRequest | null {
  const fields = (query.get('indicators') ?? '').split(',').sort();
  const same = (expected: readonly string[]) => canonical(fields) === canonical([...expected].sort());
  const source = path === '/choice/ctr' && query.get('reportName') === 'BondIssueDetail' && same(ISSUE_FIELDS) ? 'issue-detail'
    : path === '/choice/css' && same(ISSUE_PRICING_FIELDS) ? 'issue-pricing'
    : path === '/choice/css' && same(['RAISEWAY', 'MATURITYDATE']) ? 'bond-placement' : null;
  if (!source) return null;
  const allowed = source === 'issue-detail' ? ['reportName', 'indicators', 'options'] : ['codes', 'indicators', 'options'];
  if ([...query.keys()].some(k => !allowed.includes(k)) || [...query.values()].some(v => v.length > 16_000)) {
    throw new Error('Unsupported issuance observation parameters');
  }
  const codes = (query.get('codes') ?? '').split(',').filter(Boolean).map(c => c.toUpperCase()).sort();
  const parameters = { ...Object.fromEntries(query), indicators: fields.join(','), ...(source === 'issue-detail' ? {} : { codes: codes.join(',') }) };
  const dates = bonds.filter(b => codes.includes(b.code.toUpperCase())).map(b => ({ code: b.code.toUpperCase(), date: b.date })).sort((a,b) => a.code.localeCompare(b.code));
  if (source !== 'issue-detail' && (new Set(codes).size !== codes.length || dates.length !== codes.length
      || new Set(dates.map(b => b.code)).size !== codes.length || !codes.every(code => dates.some(b => b.code === code))
      || dates.some(b => !sourceDate(b.date)))) throw new Error('Incomplete original issuance date context');
  return observationRequest.parse({ source, path, parameters, bonds: dates });
}
export function requestKey(instance: string, request: ObservationRequest): string {
  return `${instancePrefix(instance)}requests/${request.source}/${observationHash(canonical(request))}.json`;
}
export function sanitizeObservation(request: ObservationRequest, value: unknown): ObservationPayload {
  const table = z.object({ function: z.string(), fields: z.array(z.string()).optional(), rows: z.array(z.record(z.string(), z.unknown())) }).parse(value);
  if (table.function !== (request.source === 'issue-detail' ? 'CTR' : 'CSS')) throw new Error('Unexpected observation table');
  const fields = request.parameters.indicators!.split(','), keys = [...new Set([...fields, request.source === 'issue-detail' ? 'SECUCODE' : 'code'])];
  const rows = table.rows.map(row => Object.fromEntries(keys.filter(k => Object.hasOwn(row,k)).map(k => [k,row[k]])));
  return observationPayload.parse({ function: table.function, fields, rows });
}
export function observationQuality(request: ObservationRequest, payload: ObservationPayload) {
  const requested = request.parameters.codes?.split(',') ?? [], returned: string[] = [];
  const rows = payload.rows.map(row => {
    const code = String(row[request.source === 'issue-detail' ? 'SECUCODE' : 'code'] ?? '').toUpperCase();
    returned.push(code);
    const fields = payload.fields.map(field => ({ field, state: !Object.hasOwn(row,field) ? 'absent' : row[field] === null ? 'null'
      : ['', '--', '—'].includes(String(row[field])) ? 'empty' : 'value' }));
    const date = request.bonds.find(b => b.code === code)?.date;
    const tender = pricingDate(row.TENDERDATE);
    const quarantined = request.source === 'issue-pricing' && row.TENDERDATE != null && row.TENDERDATE !== ''
      && (!tender || !date || tender > date);
    return { code, fields, quarantined, unexpected_code: !code || (requested.length > 0 && !requested.includes(code)) };
  });
  return { requested_codes: requested, returned_codes: returned, missing_codes: requested.filter(c => !returned.includes(c)),
    duplicate_codes: [...new Set(returned.filter((c,i) => returned.indexOf(c) !== i))], rows };
}
