import type { DataApiRequest } from './economic-indicator-sync.ts';
import { isChoiceError } from './choice-css-batch.ts';
import { observationDescriptor, sanitizeObservation, instancePrefix, requestKey, type ObservationBond } from './issuance-observation-contract.ts';
import { saveObservation, type ObservationBucket, type ObservationContent } from './issuance-observation-store.ts';
import { sourceDate } from './quant-input-contract.ts';

export type ObservationArchiveResult = { source: string; status: 'archived' | 'failed'; key?: string;
  outcome: ObservationContent['kind']; observed_at: string | null; error?: string };
/** Live capture never retries or replaces the existing paid request. Replay is a separate Workflow branch. */
export function issuanceObservationRequests(bucket: ObservationBucket, instance: string, scheduledDate: string,
  upstream: DataApiRequest) {
  instancePrefix(instance);
  if (sourceDate(scheduledDate) !== scheduledDate) throw new Error('Invalid observation scheduled date');
  const results: ObservationArchiveResult[] = [];
  const forBonds = (bonds: ObservationBond[] = []): DataApiRequest => async (path, parameters) => {
    const request = observationDescriptor(path,parameters,bonds);
    if (!request) return upstream(path,parameters);
    let raw: unknown, error: unknown, failed = false;
    try { raw = await upstream(path,parameters); }
    catch (cause) { failed = true; error = cause; }
    const received = new Date().toISOString();
    let content: ObservationContent;
    if (failed) {
      const code = isChoiceError(error,10003008) || /invalid stock code/i.test(String(error)) ? 10003008
        : isChoiceError(error,10000009) ? 10000009 : null;
      content = { kind: code === 10003008 ? 'invalid_code' : code === 10000009 ? 'no_data' : 'source_error', error_code: code };
    } else {
      try { content = { kind: 'response', payload: sanitizeObservation(request,raw) }; }
      catch { content = { kind: 'invalid_response', error_code: null }; }
    }
    try {
      const saved = await saveObservation(bucket,instance,scheduledDate,request,content,received);
      results.push({ source: request.source, status: 'archived', key: saved.key, outcome: content.kind, observed_at: saved.record.observed_at });
    } catch {
      // Only finite identifiers and failure categories cross the Workflow log boundary.
      results.push({ source: request.source, status: 'failed', key: requestKey(instance,request), outcome: content.kind, observed_at: content.kind === 'response' ? received : null,
        error: 'Observation archive unavailable or conflicting; response not durably archived' });
    }
    if (failed) throw error;
    return raw;
  };
  return { request: forBonds(), forBonds, results };
}
