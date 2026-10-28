import { createHash } from 'node:crypto';

/** Describes the bytes received at the Data transport boundary, before JSON parsing. */
export type DataResponseEvidence = {
  capturedAt: string; stage: string; status: number | null; requestId: string | null; cfRay: string | null;
  complete: boolean; receivedBytes: number; retainedBytes: number;
  rawBodySha256: string | null; retainedBodySha256: string | null;
  body: string | null; redacted: boolean;
};
export type CaptureDataResponse = (evidence: DataResponseEvidence) => Promise<void>;

export class CssResponseArchiveError extends Error {
  constructor() { super('CSS response archive unavailable; paid intent retained, no automatic replay'); this.name = 'CssResponseArchiveError'; }
}

export async function saveCssResponse(bucket: Pick<R2Bucket, 'put'>, intentKey: string,
  request: unknown, evidence: DataResponseEvidence) {
  const key = intentKey.replace('data-observations/css-budget/', 'data-observations/css-responses/');
  const body = JSON.stringify({ version: 'history-css-response-v1', intentKey,
    request, ...evidence, storedBodySha256: evidence.body === null ? null
      : createHash('sha256').update(evidence.body).digest('hex') });
  try {
    const saved = await bucket.put(key, body, { onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json' } });
    if (!saved) throw new Error('Response evidence already exists');
  } catch { throw new CssResponseArchiveError(); }
}
