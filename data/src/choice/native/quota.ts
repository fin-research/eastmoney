/** Offline recovery of SDK 2.6.1.3 cflowaccess/capiflow. No I/O. */
export class ChoiceQuotaError extends Error {
  readonly upstreamCode: number;
  constructor(upstreamCode: number) { super('Choice upstream permission or quota request failed'); this.name = 'ChoiceQuotaError'; this.upstreamCode = upstreamCode; }
}
export interface ChoiceQuotaRequest {
  serverType: 202;
  path: '/api/auth' | '/api/count';
  service: 'API_AUTH' | 'API_COUNT';
  body: string;
}
/** JsonCpp FastWriter: alphabetically ordered object members and final LF. */
export function choiceJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) + '\n';
}
function requiredToken(token: string): void {
  if (typeof token !== 'string' || !token || /[\x00-\x1f\x7f]/.test(token)) throw new ChoiceQuotaError(10003003);
}
/** capiflow::geturi/getservice; cflowaccess::checkparams. */
export function edbQuotaRequest(token: string, count = 0): ChoiceQuotaRequest {
  requiredToken(token);
  if (!Number.isSafeInteger(count) || count < 0 || count > 0x7fffffff) throw new ChoiceQuotaError(10003003);
  return {
    serverType: 202,
    path: count === 0 ? '/api/auth' : '/api/count',
    service: count === 0 ? 'API_AUTH' : 'API_COUNT',
    body: choiceJson({ subjectName: 'EM_EDB', tokenID: token, ...(count === 0 ? {} : { num: String(count) }) }),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChoiceQuotaError(10000004);
  return value as Record<string, unknown>;
}
/** cflowaccess::handleresult: HTTP status is separate; application success is 200. */
export function assertQuotaAllowed(value: unknown): void {
  const result = object(value);
  if (result.code !== 200) throw new ChoiceQuotaError(10002010);
  if (!Array.isArray(result.data) || result.data.length === 0) throw new ChoiceQuotaError(10000004);
  for (const item of result.data) if (object(item).flag !== true) throw new ChoiceQuotaError(10001012);
}
/** cedb::handleresult counts unique nonempty returned series, including null observations. */
export function edbQuotaCount(sheets: readonly { name: string; rows: readonly unknown[] }[]): number {
  return new Set(sheets.filter(sheet => sheet.rows.length > 0).map(sheet => sheet.name)).size;
}
/** SDK reqflowaccessboth(count>0) always authorizes again before submitting count.
 * Caller invokes this once before EDB query with count=0, then after decoding with count>0.
 * Await every acknowledgement; do not return data if accounting fails.
 */
export function edbQuotaRequests(token: string, count = 0): ChoiceQuotaRequest[] {
  const auth = edbQuotaRequest(token);
  return count === 0 ? [auth] : [auth, edbQuotaRequest(token, count)];
}
/** Injection-only orchestration: auth -> query/decode -> auth -> count -> return.
 * A failed accounting acknowledgement withholds the decoded data. */
export async function executeAccountedEdb<T>(token: string, quota: (request: ChoiceQuotaRequest) => Promise<unknown>, query: () => Promise<{ value: T; sheets: readonly { name: string; rows: readonly unknown[] }[] }>): Promise<T> {
  for (const request of edbQuotaRequests(token)) assertQuotaAllowed(await quota(request));
  const result = await query();
  const count = edbQuotaCount(result.sheets);
  if (count > 0) for (const request of edbQuotaRequests(token, count)) assertQuotaAllowed(await quota(request));
  return result.value;
}
export const statisticsFields = ['FUNCENAME', 'FUNCNAME', 'SECUTYPE', 'PERIOD', 'STARTDATE', 'ENDDATE', 'THRESHOLD', 'USEDDATA', 'USEDRATIO', 'AVAILABEDATA', 'PACKAGENAME', 'EFFECTIVEDATE'] as const;
type StatisticsField = typeof statisticsFields[number];
export interface ChoiceStatisticsRequest { serverType: 202; path: '/api/dataCount/query'; service: 'DATA_STATISTICS'; fields: string[]; body: string; }
/** public datastatistics uses CAccountInfo::GetToken(), exactly like EDB quota. */
export function statisticsRequest(token: string, payload: { funcName?: string; indicators?: string; startDate?: string; endDate?: string }, currentDate: string): ChoiceStatisticsRequest {
  requiredToken(token);
  const fields = payload.indicators ? payload.indicators.toUpperCase().replaceAll(' ', '').split(',') : [...statisticsFields];
  if (fields.some(field => !statisticsFields.includes(field as StatisticsField))) throw new ChoiceQuotaError(10003003);
  const startDate = payload.startDate ?? currentDate, endDate = payload.endDate ?? currentDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new ChoiceQuotaError(10003003);
  const subjectName = payload.funcName ?? '';
  if (subjectName.includes(',')) throw new ChoiceQuotaError(10003003);
  return { serverType: 202, path: '/api/dataCount/query', service: 'DATA_STATISTICS', fields, body: choiceJson({
    column: fields.join(','), endDate, startDate, tokenID: token, ...(subjectName ? { subjectName } : {}),
  }) };
}
function scalarString(value: unknown, integer = false): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(Math.trunc(value)))) throw new ChoiceQuotaError(10000004);
    return String(integer ? Math.trunc(value) : value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  throw new ChoiceQuotaError(10000004);
}
/** Upstream supplies USEDRATIO/AVAILABEDATA; the SDK does not derive them. */
export function statisticsRows(value: unknown, fields: readonly string[]): Record<string, string>[] {
  const result = object(value);
  if (result.code === 429) throw new ChoiceQuotaError(10000016);
  if (result.code !== 200) throw new ChoiceQuotaError(10002010);
  if (!Array.isArray(result.data)) throw new ChoiceQuotaError(10000004);
  if (!result.data.length) throw new ChoiceQuotaError(10000009);
  return result.data.map(item => {
    const row = object(item);
    return Object.fromEntries(fields.map(field => [field, scalarString(row[field], ['THRESHOLD', 'USEDDATA', 'AVAILABEDATA'].includes(field))]));
  });
}
