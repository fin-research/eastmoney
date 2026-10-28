export const FINANCING_TIME_ZONE = 'Asia/Shanghai';

/**
 * Source timestamps without an offset are Shanghai wall time. Preserve explicit
 * offsets and fractional precision (updated_at is also an optimistic-lock token).
 * DATE values are deliberately not accepted or converted here.
 * @param {string | Date} value
 */
export function financingTimestamp(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('时间戳无效');
    return value.toISOString();
  }
  const text = String(value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(?:\.\d{1,6})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(text);
  if (!match) throw new Error('时间戳必须包含日期和时间');
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]
    || Number(match[2]?.slice(0, 2)) > 23 || Number(match[2]?.slice(3)) > 59
    || Number(match[3]?.slice(1, 3) ?? 0) > 59) throw new Error('时间戳无效');
  let offset = match[4]?.toUpperCase() ?? '+08:00';
  if (/^[+-]\d{2}$/.test(offset)) offset += ':00';
  else if (/^[+-]\d{4}$/.test(offset)) offset = offset.slice(0, 3) + ':' + offset.slice(3);
  const result = `${match[1]}T${match[2]}${match[3] ?? ':00'}${offset}`;
  if (!Number.isFinite(Date.parse(result))) throw new Error('时间戳无效');
  return result;
}

/** @param {string | Date} value @param {Intl.DateTimeFormatOptions} [options] */
export function formatFinancingTimestamp(value, options = {}) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...options, timeZone: FINANCING_TIME_ZONE, hourCycle: 'h23',
  }).format(new Date(financingTimestamp(value)));
}

/** @param {Date} [instant] */
export function financingToday(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FINANCING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}
