import { z } from 'zod';
import { researchSearchSchema } from './research-search.ts';
import { progressPatch } from './trading-progress.ts';
import { creditMaskedQuerySchema } from '../credit/masked.ts';
import { conclusionUpdateSchema, timingDecisionInputSchema, sellSideSummaryUpdateSchema } from '../financing-model.ts';
import { policyCategorySchema, articleAssociationUpdateSchema } from '../policies.ts';
import { createCommentarySchema, updateCommentarySchema, commentaryTypeSchema, dateSchema } from '../commentary.ts';
import { saveSchema } from '../trading-workflow/model.ts';
import { projectCreateSchema } from '../financing/project-form.ts';
import { DATA_ENTITIES } from '../financing/data-admin.ts';

const empty = z.object({}).strict();
// Keep Unicode validation at runtime: JSON Schema patterns cannot carry the required /u flag.
const id = z.string().min(1).max(240).refine(v => /^[\p{L}\p{N}_|.-]+$/u.test(v)).refine(v => v !== '.' && v !== '..');
const dates = { startDate: dateSchema.optional(), endDate: dateSchema.optional() };
const queryValues = z.record(z.string().max(100), z.union([z.string().max(4000), z.array(z.string().max(4000)).max(100)]));
const formValues = queryValues.describe('与网站表单相同的字段；多值字段使用字符串数组。缺失字段不会自动补齐，更新前先读取当前记录。');
export interface McpOperation {
  name: string; title: string; path: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  input: z.ZodObject; format?: 'page' | 'form' | 'html'; action?: string; description?: string; readOnly?: boolean;
}
function api(name: string, title: string, path: string, method: McpOperation['method'] = 'GET', input: z.ZodObject = empty, extra: Partial<McpOperation> = {}): McpOperation {
  return { name, title, path, method, input, ...extra };
}
const at = (body: z.ZodType) => z.object({ id, body }).strict();
const body = (schema: z.ZodType) => z.object({ body: schema }).strict();
const bondLedgerInput = z.object({ query: z.object({ start: dateSchema.optional(), end: dateSchema.optional() }).strict()
  .refine(value => (value.start === undefined) === (value.end === undefined), '统计范围必须同时包含起止日期')
  .refine(value => !value.start || !value.end || value.start <= value.end, '统计起始日期不能晚于结束日期').optional() }).strict();
const query = (shape: z.ZodRawShape) => z.object({ query: z.object(shape).strict().optional() }).strict();
function page(name: string, title: string, path: string, input: z.ZodObject = empty) { return api(name, title, path, 'GET', input, { format: 'page' }); }
function form(name: string, title: string, path: string, action: string, fields: string, schema: z.ZodType = formValues) {
  return api(name, title, path, 'POST', z.object({ ...(path.includes('[id]') ? { id } : {}), form: schema }).strict(), {
    action, format: 'form', description: `表单字段：${fields}。由网站原有 action 校验、写入并返回结果。`,
  });
}
export const mcpOperations: McpOperation[] = [
  api('market_report', '读取市场点评定稿', '/api/market-report', 'GET', query({ date: dateSchema.optional() })),
  api('save_market_report', '保存市场点评定稿', '/api/market-report', 'PUT', z.object({ query: z.object({ date: dateSchema }), body: z.object({ report: z.record(z.string(), z.unknown()), focusText: z.string().optional() }) }).strict()),
  api('hotspots', '读取最新市场热点快照', '/api/rag/hotspots'),
  api('policies', '查询政策时间轴', '/api/policies', 'GET', query({ ...dates, category: policyCategorySchema.optional() })),
  api('research_search', 'AI Search 研报与政策检索', '/api/research/search', 'POST', body(researchSearchSchema), { readOnly: true, description: '返回原始检索片段、元数据及评分。published_at 使用上海时区 Unix 毫秒硬过滤；默认最近七个自然日，max_num_results 固定50。' }),
  api('policy_articles', '搜索可关联研报', '/api/policies/articles', 'GET', query({ q: z.string().max(120).optional() })),
  api('update_policy_articles', '更新政策关联研报', '/api/policies/[id]/articles', 'PUT', at(articleAssociationUpdateSchema)),
  ...['articles', 'news'].map((kind, index) => api(['article', 'news'][index]!, ['读取研报正文', '读取新闻详情'][index]!, `/api/${kind}/[id]`, 'GET', z.object({ id }).strict())),
  api('commentaries', '查询标准点评', '/api/commentaries', 'GET', query({ q: z.string().max(240).optional(), type: commentaryTypeSchema.optional(), offset: z.number().int().min(0).max(100000).optional(), policyId: id.optional() })),
  api('commentary', '读取标准点评', '/api/commentaries/[id]', 'GET', z.object({ id }).strict()),
  api('commentary_revisions', '读取标准点评历史版本', '/api/commentaries/[id]/revisions', 'GET', z.object({ id }).strict()),
  api('create_commentary', '创建标准点评', '/api/commentaries', 'POST', body(createCommentarySchema)),
  api('update_commentary', '修改标准点评', '/api/commentaries/[id]', 'PUT', at(updateCommentarySchema)),
  api('economic_indicators', '读取经济指标与趋势', '/api/economic-indicators'),
  api('credit_report', '读取脱敏授信一览表', '/api/credit?view=masked', 'GET', query(creditMaskedQuerySchema.omit({view:true}).shape)),
  api('bond_ledger', '读取二级池台账与周报', '/api/bond-ledger', 'GET', bondLedgerInput, { description: '不传日期返回可用台账日清单；query.start 与 query.end 必须同时提供，读取现行二级池运营周报数据。金额为元；年化收益和风险指标为小数，flatStatic、reportYield、weightedYield 为原报表百分数；不下载原始文件。' }),
  api('delete_bond_ledger', '删除指定日期二级池台账', '/api/bond-ledger', 'DELETE', z.object({ query: z.object({ date: dateSchema }) }).strict()),
  api('financing_model', '读取融资择时模型报告', '/api/financing-model', 'GET', query({ run: z.string().uuid().optional() })),
  api('update_model_conclusion', '修改融资模型结论', '/api/financing-model/conclusion', 'PATCH', body(conclusionUpdateSchema)),
  api('timing_decisions', '读取融资择时决策历史', '/api/financing-model/decisions'),
  api('create_timing_decision', '保存融资择时决策', '/api/financing-model/decisions', 'POST', body(timingDecisionInputSchema)),
  api('update_sell_side', '修改卖方观点总结', '/api/financing-model/sell-side', 'PATCH', body(sellSideSummaryUpdateSchema)),
  api('trading_workflow', '读取交易流程配置', '/api/trading-workflow/config'),
  api('save_trading_workflow', '保存交易流程配置', '/api/trading-workflow/config', 'PUT', body(saveSchema)),
  api('save_trading_progress', '更新本人当日交易进度', '/api/trading-workflow/day', 'PUT', body(progressPatch)),
  api('trading_progress', '读取本人当日交易进度', '/api/trading-workflow/day'),
  page('fund_reports', '查询历史资金日报', '/fund-report'),
  api('fund_report', '读取资金日报 HTML', '/fund-report/[id].html', 'GET', z.object({ id: dateSchema }).strict(), { format: 'html' }),
  page('financing_overview', '读取融资总览', '/financing', query({ preset: z.enum(['all', 'no_interbank', 'no_interbank_swap', 'core_financing', 'custom']).optional(), type: z.array(z.string().max(100)).max(30).optional() })),
  page('financing_projects', '查询融资项目与甘特图', '/financing/projects'),
  page('financing_project', '读取融资项目、任务与成员', '/financing/projects/[id]', z.object({ id }).strict()),
  api('project_options', '读取项目创建选项', '/financing/projects/options'),
  form('create_project', '创建融资项目并套用 SOP', '/financing/projects', 'createProject', 'name,sopTemplateId,amountYi,ownerId,notes,plannedBookbuildingDate', projectCreateSchema),
  form('update_project', '更新融资项目', '/financing/projects', 'updateProject', 'id,name,status,ownerId,notes,plannedBookbuildingDate'),
  form('delete_project', '删除融资项目及关联提醒', '/financing/projects', 'deleteProject', 'id'),
  form('update_project_task', '更新项目任务', '/financing/projects/[id]', 'updateTask', 'taskId,status,assigneeId,scheduleType,plannedStartDate,dueDate'),
  form('update_own_task', '更新本人任务状态', '/financing/projects/[id]', 'updateOwnTaskStatus', 'taskId,status'),
  form('create_project_task', '添加项目任务', '/financing/projects/[id]', 'addTask', 'name,assigneeId,scheduleType,plannedStartDate,dueDate'),
  page('sop_templates', '查询融资 SOP 模板', '/financing/sop'),
  page('sop_template', '读取 SOP 模板及节点', '/financing/sop/[id]', z.object({ id }).strict()),
  form('create_sop', '创建融资 SOP', '/financing/sop', 'createSop', 'name,debtType,description'),
  form('update_sop', '修改融资 SOP', '/financing/sop/[id]', 'updateTemplate', 'name,debtType,description'),
  form('toggle_sop', '启停融资 SOP', '/financing/sop/[id]', 'toggleTemplate', '无'),
  ...([['addNode', 'create_sop_node', '新增 SOP 节点'], ['updateNode', 'update_sop_node', '修改 SOP 节点'], ['deleteNode', 'delete_sop_node', '删除 SOP 节点'], ['reorderNodes', 'reorder_sop_nodes', '排序 SOP 节点']] as const).map(([action, name, title]) => form(name, title, '/financing/sop/[id]', action, 'nodeId,name,description,ownerRole,scheduleType,startOffsetDays,offsetDays,orderedNodeIds（逗号分隔）')),
  page('financing_clients', '查询融资客户', '/financing/clients', query({ q: z.string().max(200).optional(), page: z.number().int().min(1).max(100000).optional() })),
  ...([['create', 'create_client', '创建融资客户'], ['update', 'update_client', '修改融资客户']] as const).map(([action, name, title]) => form(name, title, '/financing/clients', action, 'id（修改）,version（修改）,name,fullname,type,subtype,aliases（换行分隔）')),
  page('bond_investors', '查询债券投资人', '/financing/bond-investors', query({ date: dateSchema.optional() })),
  page('liability_report', '读取负债周报快照', '/financing/liability-report', query({ date: dateSchema.optional() })),
  api('liability_report_data', '读取负债周报计算数据', '/financing/data/api/rpc/liability_weekly_report_data', 'POST', body(z.object({ p_report_date: dateSchema })), { description: '只读计算，不保存快照。' }),
  ...(['GET', 'POST', 'PATCH', 'DELETE'] as const).map((method, i) => api(['financing_data', 'create_financing_data', 'update_financing_data', 'delete_financing_data'][i]!, ['查询融资台账记录', '新增融资台账记录', '修改融资台账记录', '删除融资台账记录'][i]!, '/financing/data/api/[id]', method, z.object({ id: z.enum([...new Set(DATA_ENTITIES.map(item => item.tableName))] as [string, ...string[]]), query: queryValues.optional(), ...(['POST', 'PATCH'].includes(method) ? { body: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())).max(500)]) } : {}) }).strict(), { description: '与网站数据后台共用表/字段白名单、主键和 RLS。query 支持 select/order/limit/offset，筛选值 eq.值；更新或删除须包含完整主键和原值条件。' })),
];

export function operationPath(operation: McpOperation, input: Record<string, unknown>, pageData = false): string {
  let path = operation.path.replace('[id]', encodeURIComponent(String(input.id ?? '2000-01-01')));
  if (pageData && operation.format === 'page') path += '/__data.json';
  const url = new URL(path, 'https://eastmoney.hasbai.xyz');
  if (operation.action) url.searchParams.set('/' + operation.action, '');
  for (const [key, value] of Object.entries((input.query ?? {}) as Record<string, unknown>)) {
    if (key.startsWith('/') || key === 'x-sveltekit-invalidated') throw new Error('保留的查询参数');
    if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url.pathname + url.search;
}
