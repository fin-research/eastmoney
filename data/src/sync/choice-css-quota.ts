import type { DataApiRequest } from './economic-indicator-sync.ts';
import { isChoiceError } from './choice-css-batch.ts';

/** The shared Workflow preflight has already exhausted its allowed lookup attempts. */
export class CssQuotaSnapshotError extends Error {}

/** Query the quota report once. Never retry or execute paid CSS here. */
export async function requestCssQuota(
  request: DataApiRequest,
): Promise<unknown> {
  const requestedAt = new Date().toISOString();
  const parameters = { funcName: 'EM_CSS',
    indicators: 'FUNCENAME,SECUTYPE,PERIOD,STARTDATE,ENDDATE,THRESHOLD,USEDDATA,AVAILABEDATA' };
  try {
    const result = await request('/choice/data-statistics', new URLSearchParams(parameters));
    const rows = (result as { rows?: Record<string, unknown>[] } | null)?.rows;
    console.log(JSON.stringify({ event: 'choice_css_quota_response', attempt: 1,
      requestedAt, receivedAt: new Date().toISOString(), parameters,
      periods: Array.isArray(rows) ? rows.slice(0, 10).map(row => ({ function: row.FUNCENAME,
        securityType: row.SECUTYPE, period: row.PERIOD, start: row.STARTDATE, end: row.ENDDATE })) : null }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ event: 'choice_css_quota_unavailable', attempt: 1,
      requestedAt, receivedAt: new Date().toISOString(), parameters,
      upstreamCode: isChoiceError(error, 10000009) ? 10000009 : null }));
    // No quota rows says nothing about bond quotes or remaining allowance.
    // The caller must still validate the returned period and shared reserve.
    throw error;
  }
}
