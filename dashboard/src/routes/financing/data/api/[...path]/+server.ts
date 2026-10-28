import { getDirectory } from '$lib/server/directory';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/financing/db.js';
import { compileDataAdminQuery } from '$lib/server/financing/data-admin-query';

const handle: RequestHandler = async (event) => {
  if (!event.locals.user?.authorization) throw error(401, '请先登录');
  if (event.request.method !== 'GET' && event.request.headers.get('Origin') !== event.url.origin) throw error(403, '仅允许从本站提交操作');
  let body: unknown;
  if (event.request.method === 'POST' || event.request.method === 'PATCH') {
    const reader = event.request.body?.getReader();
    if (!reader) throw error(400, '缺少记录数据');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw error(413, '记录数据过大'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw error(400, '记录数据格式无效'); }
  }
  let query;
  try { query = compileDataAdminQuery(event.params.path, event.request.method, event.url.searchParams, body); }
  catch (failure) { throw error(400, failure instanceof Error ? failure.message : '数据请求无效'); }
  try {
    const result = await getDatabase().transaction(async (db: ReturnType<typeof getDatabase>) => {
      // LOCAL settings are scoped to this transaction and disappear on commit/rollback.
      await db.query("SELECT set_config('request.auth.user_id', $1, true), set_config('request.auth.permissions', $2, true), set_config('request.auth.operation', $3, true)", [event.locals.user!.auth0Id, JSON.stringify(event.locals.permissions), event.request.method]);
      await db.query('SET LOCAL ROLE authenticated');
      const rows = (await db.query(query.sql, query.values)).rows.map((item) => item.row);
      const total = query.countSql ? Number((await db.query(query.countSql, query.countValues)).rows[0]?.total ?? 0) : rows.length;
      return { rows, total };
    });
    if (event.params.path === 'rpc/liability_weekly_report_data') {
      const people = await getDirectory().people();
      for (const project of result.rows[0]?.report?.projects ?? []) project.ownerName = people.find(person => person.id === project.ownerId)?.name ?? (project.ownerId ? '已移除账号' : null);
    }
    return json(event.params.path === 'rpc/liability_weekly_report_data' ? result.rows[0] : result.rows, { headers: { 'Cache-Control': 'no-store, private', 'Content-Range': `*/${result.total}` } });
  } catch (failure) {
    const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : '';
    if (code === '42501') throw error(403, '数据权限已变更，请重新登录');
    if (typeof code === 'string' && code.startsWith('22')) throw error(400, '数据格式无效，请检查日期、数值和字段类型');
    if (typeof code === 'string' && code.startsWith('23')) throw error(409, '数据违反约束，请检查重复记录、引用和必填项');
    throw error(503, '数据后台暂时不可用，请稍后重试');
  }
};

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
