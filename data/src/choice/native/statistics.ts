import { readUpstreamJson } from '../../upstream-diagnostics';
import type { ChoiceTable } from '../client';
import { statisticsRequest, statisticsRows } from './quota';

/** SDK HTTPS branch, type202. Numeric upstream errors survive the private binding. */
export async function fetchNativeStatistics(origin: string, token: string, payload: Record<string, unknown>, timeout = 60_000): Promise<ChoiceTable> {
  const optional = (key: string): string | undefined => {
    const value = payload[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new Error('Invalid Choice statistics parameter');
    return value;
  };
  const query = statisticsRequest(token, { funcName: optional('funcName'), indicators: optional('indicators'), startDate: optional('startDate'), endDate: optional('endDate') }, new Date(Date.now() + 8 * 3600_000).toISOString().slice(0,10));
  const response = await fetch(new URL(query.path, origin), {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: query.body, signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Choice statistics HTTP request failed'); }
  return { function: 'DATASTATISTICS', fields: query.fields, rows: statisticsRows(await readUpstreamJson(response, [token]), query.fields) };
}
