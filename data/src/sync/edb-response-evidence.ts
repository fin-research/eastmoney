import { createHash } from 'node:crypto';
import type { DataResponseEvidence } from './css-response-evidence.ts';
import type { RequestSpec } from './economic-indicator-run.ts';

/** Internal Data HTTP evidence, not original Choice RPC or SDK bytes. */
export async function saveEdbResponse(bucket: Pick<R2Bucket, 'put'>, workflowInstanceId: string,
  scheduledTime: number, request: RequestSpec, attempt: number, evidence: DataResponseEvidence) {
  const key = `data-observations/edb-responses/${encodeURIComponent(workflowInstanceId)}/${request.id}/attempt-${attempt}.json`;
  const body = JSON.stringify({ version: 'edb-response-v1', workflowInstanceId, scheduledTime,
    request, attempt, ...evidence, storedBodySha256: evidence.body === null ? null
      : createHash('sha256').update(evidence.body).digest('hex') });
  const saved = await bucket.put(key, body, { onlyIf: new Headers({ 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'application/json' } });
  if (!saved) throw new Error('EDB response evidence already exists');
}
