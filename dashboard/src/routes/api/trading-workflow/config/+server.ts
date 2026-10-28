import { z } from 'zod';
import { AccessError } from '$lib/server/access';
import { requireSameOrigin } from '$lib/server/dashboard-access';
import { readWorkflowConfig, saveWorkflowConfig, WorkflowConfigError } from '$lib/server/trading-workflow';
import { saveSchema } from '$lib/trading-workflow/model';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'no-store, private' };
export const GET: RequestHandler = async ({ locals, platform }) => {
  try {
    if (!locals.user) throw new AccessError(401, '请先登录');
    if (!locals.user.authorization?.permissions.includes('research.workspace:read')) throw new AccessError(403, '无权读取交易流程');
    if (!platform?.env.DB) throw new WorkflowConfigError(503, '交易流程配置暂不可用');
    return Response.json({ ...await readWorkflowConfig(platform.env.DB), actorKey: locals.user.id,
      canEdit: locals.user.authorization.permissions.includes('research.workflow:update') }, { headers });
  } catch (error) { return failure(error); }
};
export const PUT: RequestHandler = async ({ locals, platform, request }) => {
  try {
    requireSameOrigin(request);
    if (!locals.user) throw new AccessError(401, '请先登录');
    if (!locals.user.authorization?.permissions.includes('research.workflow:update')) throw new AccessError(403, '无权编辑交易流程');
    if (!platform?.env.DB) throw new WorkflowConfigError(503, '交易流程配置暂不可用');
    const body = await request.text();
    if (body.length > 300_000) throw new WorkflowConfigError(413, '节点配置过大');
    const parsed = saveSchema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new WorkflowConfigError(400, parsed.error.issues[0]?.message ?? '节点配置无效');
    return Response.json(await saveWorkflowConfig(platform.env.DB, parsed.data), { headers });
  } catch (error) { return failure(error); }
};
function failure(error: unknown) {
  const status = error instanceof AccessError || error instanceof WorkflowConfigError ? error.status : error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 500;
  const code = status === 401 ? 'LOGIN_REQUIRED' : status === 403 ? 'ACCESS_DENIED' : status === 409 ? 'WORKFLOW_CONFIG_CONFLICT' : status === 400 ? 'INVALID_WORKFLOW_CONFIG' : 'WORKFLOW_CONFIG_UNAVAILABLE';
  return Response.json({ code, error: error instanceof AccessError || error instanceof WorkflowConfigError ? error.message : status === 400 ? '节点配置无效' : '交易流程配置读取或保存失败' }, { status, headers });
}
