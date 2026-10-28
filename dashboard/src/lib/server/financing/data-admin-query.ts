import { DATA_ENTITIES, type DataRow } from '../../financing/data-admin';
import { LIABILITY_REPORT_EDB_CODES } from '../../financing/liability-report-data.js';

export type DataQuery = { sql: string; values: unknown[]; countSql?: string; countValues?: unknown[] };

/** Compile the existing data editor's small REST vocabulary into bound SQL. */
export function compileDataAdminQuery(table: string, method: string, query: URLSearchParams, body?: unknown): DataQuery {
  if (table === 'rpc/liability_weekly_report_data') {
    const date = body && typeof body === 'object' && 'p_report_date' in body ? body.p_report_date : null;
    if (method !== 'POST' || [...query].length || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('周报请求无效');
    return { sql: 'SELECT financing.liability_weekly_report_data($1::date) AS row', values: [date] };
  }
  if (table === 'liability_market_rate_observations') {
    const dates = query.getAll('observation_date');
    const start = dates.find((date) => date.startsWith('gte.'))?.slice(4);
    const end = dates.find((date) => date.startsWith('lte.'))?.slice(4);
    if (method !== 'GET' || dates.length !== 2 || !start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start)
      || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error('市场利率日期无效');
    if (query.get('indicator_code') !== `in.(${LIABILITY_REPORT_EDB_CODES.join(',')})`
      || query.get('select') !== 'indicator_code,observation_date,value'
      || query.get('order') !== 'indicator_code.asc,observation_date.asc' || query.get('limit') !== '5000'
      || [...query.keys()].some((key) => !['select', 'order', 'limit', 'indicator_code', 'observation_date'].includes(key))) throw new Error('市场利率查询无效');
    return { sql: 'SELECT row_to_json(result) AS row FROM (SELECT indicator_code,observation_date,value FROM financing.liability_market_rate_observations WHERE indicator_code = ANY($1::text[]) AND observation_date >= $2::date AND observation_date <= $3::date ORDER BY indicator_code,observation_date LIMIT 5000) result', values: [LIABILITY_REPORT_EDB_CODES, start, end] };
  }
  const configs = DATA_ENTITIES.filter((config) => config.tableName === table);
  const firstConfig = configs[0];
  if (!firstConfig || !/^[a-z_]+$/.test(table)) throw new Error('不支持的数据表');
  const fields = new Map(configs.flatMap((config) => config.fields.map((field) => [field.key, field] as const)));
  const fixedKeys = new Set(configs.flatMap((config) => Object.keys(config.fixedValues ?? {})));
  const allowed = new Set([...fields.keys(), ...fixedKeys]);
  const identifier = (key: string) => {
    if (!allowed.has(key) || !/^[a-z_][a-z_0-9]*$/.test(key)) throw new Error('字段不在数据后台白名单内');
    return `"${key}"`;
  };
  const qualified = `financing."${table}"`;
  const readSource = firstConfig.key.startsWith('debt-')
    ? `(SELECT ${[...allowed].filter(key => key !== 'status').map(identifier).join(',')}, financing.debt_status_as_of(issue_date,maturity_date,activated_at,settled_at,closed_at,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) AS status FROM ${qualified}) debt_live`
    : qualified;
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const filterKeys = new Set<string>();
  const where: string[] = [];
  for (const [key, value] of query) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    if (key.startsWith('filter_')) {
      if (method !== 'GET' || query.getAll(key).length !== 1 || !firstConfig.key.startsWith('debt-')) throw new Error('列筛选无效');
      const fieldKey = key.slice(7);
      const field = fields.get(fieldKey);
      if (!field || !['name','counterparty','amount','annual_rate','issue_date','maturity_date','status','subtype'].includes(fieldKey)) throw new Error('列筛选字段无效');
      const filter = JSON.parse(value);
      if (!filter || typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).some(key => !['value','min','max'].includes(key))) throw new Error('列筛选无效');
      const column = identifier(fieldKey);
      for (const [operator, raw] of Object.entries(filter)) {
        if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) throw new Error('列筛选值无效');
        if (field.type === 'number' || field.type === 'date') {
          if (!['min','max'].includes(operator)) throw new Error('列筛选范围无效');
          if (field.type === 'number' && !Number.isFinite(Number(raw))) throw new Error('列筛选数值无效');
          if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || new Date(raw+'T00:00:00Z').toISOString().slice(0,10)!==raw)) throw new Error('列筛选日期无效');
          const input = field.type === 'number' ? Number(raw)/(field.displayFactor??1) : raw;
          where.push(`${column} ${operator === 'min' ? '>=' : '<='} ${bind(input)}`);
        } else {
          if (operator !== 'value') throw new Error('列筛选无效');
          const exact = ['status','subtype'].includes(fieldKey);
          where.push(`${column} ${exact ? '=' : 'ILIKE'} ${bind(exact ? raw : '%'+raw.replace(/[\\%_]/g,'\\$&')+'%')}`);
        }
      }
      continue;
    }
    if (['lifecycle', 'as_of', 'issue_from', 'issue_to'].includes(key)) {
      if (method !== 'GET' || !firstConfig.key.startsWith('debt-') || query.getAll(key).length !== 1) throw new Error('负债筛选无效');
      if (key === 'lifecycle') { if (value !== 'unmatured' || !query.has('as_of')) throw new Error('负债筛选无效'); }
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) throw new Error('筛选日期无效');
        if (key === 'as_of') {
          if (query.get('lifecycle') !== 'unmatured') throw new Error('负债筛选无效');
          const date = bind(value);
          where.push(`("maturity_date" IS NULL OR "maturity_date" > ${date}::date) AND ("settled_at" IS NULL OR "settled_at" > ${date}::date) AND ("closed_at" IS NULL OR "closed_at" > ${date}::date)`);
        } else where.push(`"issue_date" ${key === 'issue_from' ? '>=' : '<='} ${bind(value)}::date`);
      }
      continue;
    }
    if (filterKeys.has(key)) throw new Error('筛选条件不得重复');
    filterKeys.add(key);
    if (key === 'or') {
      if (method !== 'GET' || !value.startsWith('(') || !value.endsWith(')')) throw new Error('搜索条件无效');
      const searchFields = new Set(configs.flatMap((config) => config.searchFields));
      const parts = value.slice(1, -1).split(',');
      if (parts.length > searchFields.size) throw new Error('搜索范围无效');
      where.push('(' + parts.map((part) => {
        const match = /^([a-z_0-9]+)\.ilike\.\*([^*]*)\*$/.exec(part);
        if (!match?.[1] || !searchFields.has(match[1])) throw new Error('搜索字段无效');
        return `${identifier(match[1])} ILIKE ${bind('%' + match[2] + '%')}`;
      }).join(' OR ') + ')');
      continue;
    }
    const column = identifier(key);
    if (value === 'is.null') where.push(`${column} IS NULL`);
    else if (value.startsWith('eq.')) where.push(`${column} = ${bind(value.slice(3))}`);
    else throw new Error('筛选条件无效');
  }
  const condition = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  if (method === 'GET') {
    for (const key of ['select', 'order', 'limit', 'offset']) if (query.getAll(key).length > 1) throw new Error('查询参数不得重复');
    const select = (query.get('select') ?? [...fields.keys()].join(',')).split(',').map(identifier).join(',');
    const order = query.get('order') ?? `${firstConfig.defaultSort.key}.${firstConfig.defaultSort.direction}.nullslast`;
    const orderParts = order.split(',');
    if (orderParts.length > 2) throw new Error('排序条件无效');
    const ordering = orderParts.map(part => {
      const match = /^([a-z_0-9]+)\.(asc|desc)\.nullslast$/.exec(part);
      if (!match?.[1]) throw new Error('排序条件无效');
      return `${identifier(match[1])} ${match[2]} NULLS LAST`;
    }).join(',');
    const limitText = query.get('limit') ?? '50'; const offsetText = query.get('offset') ?? '0';
    if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText)) throw new Error('分页参数无效');
    const limit = Number(limitText); const offset = Number(offsetText);
    if (limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset > 1000000) throw new Error('分页超出范围');
    const countValues = [...values];
    const countSql = `SELECT count(*) AS total FROM ${readSource}${condition}`;
    return { sql: `SELECT row_to_json(result) AS row FROM (SELECT ${select} FROM ${readSource}${condition} ORDER BY ${ordering} LIMIT ${bind(limit)} OFFSET ${bind(offset)}) result`, values, countSql, countValues };
  }
  if (!['POST', 'PATCH', 'DELETE'].includes(method) || configs.every((config) => config.readOnly)) throw new Error('不支持的数据操作');
  if (method !== 'POST') {
    if (!configs.some((config) => config.primaryKeys.every((key) => query.get(key)?.startsWith('eq.')))) throw new Error('更新或删除必须精确指定完整主键');
    const keys = new Set(configs.flatMap((config) => [...config.primaryKeys, 'updated_at', ...Object.keys(config.fixedValues ?? {})]));
    if ([...filterKeys].some((key) => !keys.has(key))) throw new Error('更新或删除筛选范围无效');
  } else if ([...query].length || configs.every((config) => config.canCreate === false)) throw new Error('不允许创建该类记录');
  if (method === 'DELETE') {
    if (configs.every((config) => config.canDelete === false)) throw new Error('不允许删除该类记录');
    return { sql: `WITH changed AS (DELETE FROM ${qualified}${condition} RETURNING *) SELECT row_to_json(changed) AS row FROM changed`, values };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('数据必须为单条记录');
  const entries = Object.entries(body as DataRow);
  if (!entries.length || entries.length > allowed.size) throw new Error('记录字段无效');
  for (const [key] of entries) {
    identifier(key);
    if (!fixedKeys.has(key) && fields.get(key)?.readOnly) throw new Error('不能修改只读字段');
    if (method === 'PATCH' && configs.some((config) => config.primaryKeys.includes(key))) throw new Error('不能修改主键');
  }
  const statement = method === 'POST'
    ? `INSERT INTO ${qualified} (${entries.map(([key]) => identifier(key)).join(',')}) VALUES (${entries.map(([, value]) => bind(value)).join(',')})`
    : `UPDATE ${qualified} SET ${entries.map(([key, value]) => `${identifier(key)} = ${bind(value)}`).join(',')}${condition}`;
  return { sql: `WITH changed AS (${statement} RETURNING *) SELECT row_to_json(changed) AS row FROM changed`, values };
}
