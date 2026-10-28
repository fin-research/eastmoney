import { z } from 'zod';
import * as dto from './contracts';
import { choiceTableSchema } from './choice/client';
import { ApiError, shanghaiToday } from './http';

export const RESOURCE_GROUPS = [
  { name: 'DM', description: 'DM 债券、资金、发行与资讯资源' },
  { name: 'Choice', description: 'Choice SDK 通用查询' },
  { name: '东方财富', description: '东方财富网页及股票市场数据' },
  { name: '中国货币网', description: '中国货币网实时利率与市场数据' },
  { name: '服务', description: '服务状态、配置与查询协议' },
] as const;

const date = z.string().date();
const optionalDate = date.optional();
const text = (max: number) => z.string().trim().min(1).max(max);
const csv = (max: number, count?: number) => text(max).refine(value => {
  const items = value.split(',').filter(item => item.trim());
  return items.length > 0 && (count === undefined || items.length <= count);
}, '逗号分隔参数为空或超过单次数量上限');
const integer = (max: number) => z.number().int().min(1).max(max);
const options = z.string().max(4096).optional();
const dateTime = z.string().refine(value => {
  const iso = value.replace(' ', 'T');
  return !Number.isNaN(Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + '+08:00'));
}, '不是有效时间');

type Shape = z.ZodRawShape;
export interface Resource {
  path: string;
  name: string;
  title: string;
  group: typeof RESOURCE_GROUPS[number]['name'];
  login: boolean;
  input: z.ZodObject<Shape>;
  output: z.ZodType;
  pathParameters: readonly string[];
  unavailable?: boolean;
}

function orderedRange(input: z.ZodObject<Shape>): z.ZodObject<Shape> {
  return input.superRefine((value, context) => {
    const end = value.endDate ?? value.date;
    if (typeof value.startDate === 'string' && typeof end === 'string' && value.startDate > end) {
      context.addIssue({ code: 'custom', path: ['startDate'], message: 'startDate 不能晚于 ' + (value.endDate ? 'endDate' : 'date') });
    }
  });
}

function resource(path: string, name: string, title: string, group: Resource['group'], shape: Shape,
  schema: z.ZodObject<Shape>, kind: 'list' | 'object' | 'page' = 'list', extra: Partial<Resource> = {}): Resource {
  const keys = Object.keys(schema.shape);
  const fields = z.string().regex(new RegExp('^\\s*(?:' + keys.join('|') + ')(?:\\s*,\\s*(?:' + keys.join('|') + '))*\\s*$'))
    .describe('逗号分隔稀疏字段集；允许：' + keys.join(', ')).optional();
  const projected = z.union([schema, schema.partial()]);
  const input = orderedRange(z.object({ ...shape, fields })).superRefine((value, context) => {
    if (path === '/news') {
      const pageSize = Number(value.pageSize ?? (value.detail ? 10 : 50));
      if (value.detail && pageSize > 10) context.addIssue({ code: 'custom', path: ['pageSize'], message: 'detail=true 时 pageSize 不能超过 10' });
      if (Number(value.offset ?? 0) + pageSize > 100) context.addIssue({ code: 'custom', path: ['offset'], message: 'offset + pageSize 不能超过 100' });
    }
    if (path === '/broker-bond-registrations' && typeof value.startDate === 'string' && typeof value.endDate === 'string'
      && Date.parse(value.endDate) - Date.parse(value.startDate) > 366 * 86400000) {
      context.addIssue({ code: 'custom', path: ['endDate'], message: '日期范围不能超过 366 天' });
    }
    if (path === '/primary-issues' && typeof value.startDate === 'string' && value.startDate > (typeof value.date === 'string' ? value.date : shanghaiToday())) {
      context.addIssue({ code: 'custom', path: ['startDate'], message: 'startDate 不能晚于 date' });
    }
  });
  return { path, name, title, group, login: false, pathParameters: [],
    input,
    output: kind === 'object' ? projected : kind === 'page' ? z.object({ hasNextPage: z.boolean(), rows: z.array(projected) }) : z.array(projected), ...extra };
}

function choice(path: string, name: string, title: string, shape: Shape): Resource {
  return { path: '/choice/' + path, name, title, group: 'Choice', login: true, pathParameters: [],
    input: orderedRange(z.object(shape)).superRefine((value, context) => {
      if (path === 'data-statistics' && (value.startDate === undefined) !== (value.endDate === undefined)) {
        context.addIssue({ code: 'custom', path: ['startDate'], message: 'startDate 和 endDate 必须同时提供' });
      }
    }), output: choiceTableSchema };
}

export const resources: readonly Resource[] = [
  { path: '/health', name: 'health', title: 'Health', group: '服务', login: false, pathParameters: [], input: z.object({}), output: z.object({ status: z.literal('ok') }) },
  { path: '/config', name: 'config', title: 'Config', group: '服务', login: false, pathParameters: [], input: z.object({}), output: z.object({ defaultDate: date }) },
  resource('/trading-days', 'trading_days', 'SSE Trading Day', '服务', { date: optionalDate }, dto.tradingDaySchema, 'object'),
  resource('/chinamoney/shibor', 'chinamoney_shibor', '实时 SHIBOR', '中国货币网', {}, dto.chinamoneyShiborSchema),
  resource('/omo', 'omo', 'OMO', 'DM', { startDate: date, endDate: date }, dto.omoOperationSchema),
  resource('/cfets', 'cfets', 'CFETS', 'DM', { date: optionalDate, source: z.string().regex(/^(DR|R|OR|DIBO|L)$/i).optional() }, dto.cfetsRateSchema),
  resource('/cfets-histories', 'cfets_histories', 'CFETS Historical Funding Rates', 'DM', {
    bondCode: text(32).regex(/^[A-Za-z0-9._/-]+$/), endCapitalTime: integer(Number.MAX_SAFE_INTEGER).optional(), limit: integer(100).default(100),
  }, dto.cfetsHistorySchema, 'page'),
  resource('/bond-top-case', 'bond_top_case', 'Bond Top Case', 'DM', { date: optionalDate }, dto.governmentBondSchema),
  resource('/futures-latest', 'futures_latest', 'Futures Latest', 'DM', {}, dto.futuresQuoteSchema),
  resource('/margin', 'margin', 'Margin', '东方财富', { date: optionalDate }, dto.marginBalanceSchema),
  resource('/primary-issues', 'primary_issues', 'Primary Issues', 'DM', { date: optionalDate, startDate: optionalDate }, dto.primaryIssueSchema),
  resource('/broker-bond-registrations', 'broker_bond_registrations', 'Broker Bond Registrations', 'DM', {
    startDate: date, endDate: date, pageNum: integer(10000).default(1), pageSize: integer(100).default(50),
  }, dto.brokerBondRegistrationSchema, 'page'),
  resource('/today-trades', 'today_trades', 'Today Trades', 'DM', { limit: integer(500).default(300) }, dto.todayTradeSchema),
  resource('/favorite-quotes', 'favorite_quotes', 'Favorite Quotes', 'DM', { limit: integer(500).default(100) }, dto.favoriteQuoteSchema),
  resource('/bond-infos', 'bond_infos', 'Bond Infos', 'DM', { codes: csv(8192, 500) }, dto.bondInfoSchema),
  resource('/news', 'news', 'News List', 'DM', {
    pageSize: integer(100).optional(), detail: z.boolean().optional(), offset: z.number().int().min(0).max(90).optional(), tag: z.string().optional(), date: optionalDate,
    startTime: dateTime.optional(), endTime: dateTime.optional(), important: z.boolean().optional(),
  }, dto.newsListItemSchema),
  resource('/news/{article_id}', 'news_detail', 'News Detail', 'DM', { article_id: text(1024) }, dto.newsDetailSchema, 'object', { pathParameters: ['article_id'] }),
  resource('/wechat-articles', 'wechat_articles', 'Wechat Articles', 'DM', {
    pageSize: integer(100).default(50), onlySubscription: z.boolean().default(true), startPageId: z.string().optional(), endPageId: z.string().optional(),
  }, dto.wechatArticleSchema),
  resource('/industry', 'industry', 'Industry', '东方财富', { date: optionalDate }, dto.industrySnapshotSchema, 'object'),
  resource('/stock-summary', 'stock_summary', 'Stock Summary', '东方财富', { date: optionalDate }, dto.stockSummarySchema, 'object', { unavailable: true }),
  choice('csd', 'choice_csd', 'Choice CSD', { codes: csv(4096), indicators: csv(4096, 64), startDate: date, endDate: date, options }),
  choice('css', 'choice_css', 'Choice CSS', { codes: csv(4096), indicators: csv(4096, 64), options }),
  choice('ctr', 'choice_ctr', 'Choice CTR', { reportName: text(256), indicators: z.string().max(4096).optional(), options }),
  choice('edb', 'choice_edb', 'Choice EDB', { edbIds: csv(4096, 100), startDate: date, endDate: date, options }),
  choice('data-statistics', 'choice_data_statistics', 'Choice Data Statistics', {
    funcName: z.string().max(64).optional(), indicators: z.string().max(4096).optional(), startDate: optionalDate, endDate: optionalDate, options,
  }),
];

export function findResource(path: string): Resource | undefined {
  return resources.find(resource => resource.path === path || resource.name === 'news_detail' && /^\/news\/[^/]+$/.test(path));
}

// The JSON transport adapter only decodes HTTP scalar strings. Validation and
// defaults are owned by the same Zod objects passed to OpenAPI and MCP.
const inputSchemas = new Map(resources.map(resource => [resource, z.toJSONSchema(resource.input, { io: 'input' })]));
export function validateResourceRequest(request: Request, path: string): void {
  const resource = findResource(path);
  if (!resource || !['GET', 'HEAD'].includes(request.method)) return;
  const query = new URL(request.url).searchParams;
  const input: Record<string, unknown> = {};
  const schema = inputSchemas.get(resource);
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    let value = resource.pathParameters.includes(name) ? decodeURIComponent(path.slice('/news/'.length)) : query.get(name);
    if (value === null) continue;
    if (value === '' && name === 'fields') continue;
    if (value === '' && name.toLowerCase().endsWith('date') && !schema?.required?.includes(name)) continue;
    if (typeof property !== 'object' || !property) continue;
    if (property.type === 'integer' || property.type === 'number') input[name] = /^\d+$/.test(value) ? Number(value) : value;
    else if (property.type === 'boolean') input[name] = /^(true|1|yes|on)$/i.test(value) ? true : /^(false|0|no|off)$/i.test(value) ? false : value;
    else input[name] = value;
  }
  const result = resource.input.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const name = String(issue?.path[0] ?? 'query');
    throw new ApiError(422, input[name] === undefined ? `Field required: ${name}` : issue?.code === 'custom' ? issue.message : `${name}: ${issue?.message ?? '参数无效'}`);
  }
}

export function resourceRequest(resource: Resource, input: Record<string, unknown>, origin: string): Request {
  const url = new URL(resource.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(input[name]))), origin);
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined && !resource.pathParameters.includes(name)) url.searchParams.set(name, String(value));
  }
  return new Request(url);
}
