import { z } from 'zod';
import { canonical, observationHash, observationPayload, observationQuality, observationRequest,
  instancePrefix, requestKey, sanitizeObservation, type ObservationRequest } from './issuance-observation-contract.ts';
import { observationDescriptor } from './issuance-observation-contract.ts';
import { sourceDate } from './quant-input-contract.ts';

export type ObservationBucket = Pick<R2Bucket, 'get' | 'put' | 'list'>;
const MAX_BYTES = 8 * 1024 * 1024;
const iso = z.string().datetime();
const contentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('response'), payload: observationPayload }).strict(),
  z.object({ kind: z.enum(['invalid_code', 'no_data', 'source_error', 'invalid_response']), error_code: z.number().nullable() }).strict(),
]);
export type ObservationContent = z.infer<typeof contentSchema>;
export const recordSchema = z.object({ schema_version: z.literal(1), instance_id: z.string(), scheduled_date: z.string(),
  request: observationRequest, request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_key: z.string(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  response_received_at: iso, observed_at: iso.nullable(), archived_at: iso, final_coupon_published_at: z.null(),
  quality: z.unknown() }).strict();
export type ObservationRecord = z.infer<typeof recordSchema>;
async function text(bucket: ObservationBucket, key: string) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > MAX_BYTES) throw new Error('Observation object exceeds size bound');
  return object.text();
}
async function createOnly(bucket: ObservationBucket, key: string, bytes: string) {
  if (new TextEncoder().encode(bytes).byteLength > MAX_BYTES) throw new Error('Observation exceeds size bound');
  await bucket.put(key, bytes, { onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json' } });
  const saved = await text(bucket,key);
  if (saved === null) throw new Error('Observation write not visible');
  return saved;
}
export async function saveObservation(bucket: ObservationBucket, instance: string, scheduledDate: string,
  request: ObservationRequest, content: ObservationContent, receivedAt: string) {
  const body = canonical(contentSchema.parse(content)), checksum = observationHash(body);
  const contentKey = `${instancePrefix(instance)}contents/${checksum}.json`;
  if (await createOnly(bucket,contentKey,body) !== body) throw new Error('Observation content conflict');
  const record: ObservationRecord = { schema_version: 1, instance_id: instance, scheduled_date: scheduledDate,
    request, request_sha256: observationHash(canonical(request)), content_key: contentKey, content_sha256: checksum,
    response_received_at: receivedAt, observed_at: content.kind === 'response' ? receivedAt : null,
    archived_at: new Date().toISOString(), final_coupon_published_at: null,
    quality: content.kind === 'response' ? observationQuality(request,content.payload) : null };
  const key = requestKey(instance,request), saved = recordSchema.parse(JSON.parse(await createOnly(bucket,key,canonical(record))));
  if (saved.content_sha256 !== checksum || canonical(saved.request) !== canonical(request)
      || saved.scheduled_date !== scheduledDate || saved.instance_id !== instance) throw new Error('Observation request conflict');
  await readObservation(bucket,instance,key);
  return { key, record: saved };
}
export async function readObservation(bucket: ObservationBucket, instance: string, key: string) {
  const prefix = instancePrefix(instance);
  if (!key.startsWith(`${prefix}requests/`)) throw new Error('Observation outside original instance');
  const bytes = await text(bucket,key);
  if (bytes === null) throw new Error('Original observation missing');
  const record = recordSchema.parse(JSON.parse(bytes));
  const request = observationRequest.parse(record.request);
  const descriptor = new URLSearchParams(request.parameters);
  // Re-run the finite source allowlist and original bond date validation.
  const normalized = observationDescriptor(request.path,descriptor,request.bonds);
  if (!normalized || canonical(normalized) !== canonical(request) || record.instance_id !== instance
      || key !== requestKey(instance,request) || record.request_sha256 !== observationHash(canonical(request))
      || sourceDate(record.scheduled_date) !== record.scheduled_date
      || record.content_key !== `${prefix}contents/${record.content_sha256}.json`
      || Date.parse(record.response_received_at) > Date.parse(record.archived_at)) throw new Error('Observation provenance mismatch');
  const body = await text(bucket,record.content_key);
  if (body === null || observationHash(body) !== record.content_sha256) throw new Error('Observation content checksum mismatch');
  const content = contentSchema.parse(JSON.parse(body));
  if (content.kind === 'response') {
    if (canonical(sanitizeObservation(request,content.payload)) !== canonical(content.payload)
        || record.observed_at !== record.response_received_at
        || canonical(record.quality) !== canonical(observationQuality(request,content.payload))) throw new Error('Observation response audit mismatch');
  } else if (record.observed_at !== null || record.quality !== null) throw new Error('Failed source cannot be a value observation');
  return { key, record, content, quality: content.kind === 'response' ? observationQuality(request,content.payload) : null };
}
export async function listObservationKeys(bucket: ObservationBucket, instance: string) {
  const prefix = `${instancePrefix(instance)}requests/`, keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map(o => o.key));
    if (keys.length > 4096) throw new Error('Observation instance exceeds recovery bound');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export async function saveApplicationReceipt(bucket: ObservationBucket, instance: string, result: Record<string, unknown>) {
  const key = `${instancePrefix(instance)}applications/${crypto.randomUUID()}.json`;
  const bytes = canonical({ schema_version: 1, applied_at: new Date().toISOString(), ...result });
  if (await createOnly(bucket,key,bytes) !== bytes) throw new Error('Observation application receipt conflict');
  return key;
}

const manifestSchema = z.object({ schema_version: z.literal(1), instance_id: z.string(),
  requests: z.array(z.object({ key: z.string(), source: z.enum(['issue-detail','issue-pricing','bond-placement']),
    status: z.enum(['archived','failed']), outcome: z.enum(['response','invalid_code','no_data','source_error','invalid_response']) }).strict()) }).strict();
export async function saveLiveObservationManifest(bucket: ObservationBucket, instance: string,
  observations: Array<{ key?: string; source: string; status: string; outcome: string }>) {
  const value = manifestSchema.parse({ schema_version: 1, instance_id: instance,
    requests: observations.map(({key,source,status,outcome}) => ({key,source,status,outcome})) });
  const key = `${instancePrefix(instance)}live-manifest.json`, bytes = canonical(value);
  if (await createOnly(bucket,key,bytes) !== bytes) throw new Error('Live observation manifest conflict');
  return key;
}
export async function readLiveObservationManifest(bucket: ObservationBucket, instance: string) {
  const bytes = await text(bucket,`${instancePrefix(instance)}live-manifest.json`);
  if (bytes === null) return null;
  const manifest = manifestSchema.parse(JSON.parse(bytes));
  if (manifest.instance_id !== instance || manifest.requests.some(r => !r.key.startsWith(`${instancePrefix(instance)}requests/${r.source}/`))) {
    throw new Error('Live observation manifest provenance mismatch');
  }
  return manifest;
}
