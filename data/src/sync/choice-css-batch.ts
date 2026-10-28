import { CssResponseArchiveError } from './css-response-evidence.ts';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { EconomicIndicatorRequestError } from './economic-indicator-request.ts';

export function isChoiceError(error: unknown, code: number): boolean {
  if (error instanceof EconomicIndicatorRequestError) {
    if (error.details.stage !== 'http_response' || error.details.responseTruncated) return false;
    try {
      const body = JSON.parse(error.details.responseBody ?? '{}');
      if (body.error?.upstreamResponse?.truncated || body.error?.upstreamResponse?.readError) return false;
      return body.error?.upstreamCode === code || body.error?.upstreamResponse?.body?.error?.upstreamCode === code;
    } catch { return false; }
  }
  return new RegExp(`\\b${code}\\b`).test(error instanceof Error ? error.message : String(error));
}

// Include every level of a possible invalid-code split in the preflight quota budget.
export function cssIsolationPoints(count: number, fields: number, batchSize: number): number {
  let points = 0;
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    points += size * fields * (Math.ceil(Math.log2(size)) + 1);
  }
  return points;
}

/** Only code 10003008 authorizes splitting. Persist each successful leaf immediately. */
export async function syncChoiceCssBatch(
  request: DataApiRequest, codes: string[], indicators: string[], options: string,
  apply: (codes: string[], payload: unknown) => Promise<void>,
  exclude: (code: string) => Promise<void>,
): Promise<void> {
  if (!codes.length) return;
  let payload: unknown;
  try {
    payload = await request('/choice/css', new URLSearchParams({
      codes: codes.join(','), indicators: indicators.join(','), options,
    }));
  } catch (error) {
    if (error instanceof CssResponseArchiveError || !isChoiceError(error, 10003008)) throw error;
    if (codes.length === 1) { await exclude(codes[0]!); return; }
    const middle = Math.ceil(codes.length / 2);
    await syncChoiceCssBatch(request, codes.slice(0, middle), indicators, options, apply, exclude);
    await syncChoiceCssBatch(request, codes.slice(middle), indicators, options, apply, exclude);
    return;
  }
  await apply(codes, payload);
}
