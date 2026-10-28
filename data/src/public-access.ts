import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { AccessError, accessFailure } from './access';
import { finalizeResponse, handleRequest } from './app';
import { handleGraphql } from './graphql';
import { errorResponse } from './http';
import { handleCamelRequest } from './camel/routes';
import { internalPathname } from './routing';

const contextSchema = z.object({ version: z.literal(1), choice: z.object({ status: z.union([z.literal(204), z.literal(401), z.literal(403), z.literal(503)]) }), camel: z.object({ status: z.literal(204) }).optional() });
/** The default entrypoint is closed even if someone accidentally restores a public route. */
export async function handlePublicRequest(_request: Request, _env: Cloudflare.Env): Promise<Response> {
  return new Response('Not Found', { status: 404 });
}

/** Only GatewayData consumes this metadata. Data neither verifies JWTs nor computes permissions. */
export async function handleGatewayRequest(request: Request, env: Cloudflare.Env): Promise<Response> {
  try {
    const context = contextSchema.parse(JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context') ?? '', 'base64url').toString('utf8')));
    const headers = new Headers(request.headers);
    headers.delete('X-Eastmoney-Gateway-Context');
    request = new Request(request, { headers });
    const path = internalPathname(new URL(request.url).pathname);
    if (path === '/camel' || path?.startsWith('/camel/')) {
      if (context.camel?.status !== 204) throw new AccessError(403, '无权访问资金系统');
      const response = (await handleCamelRequest(request, env))!;
      return finalizeResponse(request, request.method === 'HEAD' ? new Response(null, response) : response);
    }
    if (path === '/mcp' && context.choice.status !== 204) {
      throw new AccessError(context.choice.status, context.choice.status === 401 ? '请先登录' : context.choice.status === 403 ? '当前身份无权访问' : '身份服务暂时不可用');
    }
    if (path === '/graphql' && ['GET', 'HEAD', 'POST'].includes(request.method)) {
      try {
        return finalizeResponse(request, await handleGraphql(request, env, async () => {
          const status = context.choice.status;
          if (status !== 204) throw new AccessError(status, status === 401 ? '请先登录' : status === 403 ? '当前身份无权访问' : '身份服务暂时不可用');
        }));
      } catch (error) { return finalizeResponse(request, errorResponse(error)); }
    }
    return await handleRequest(request, env);
  } catch (error) { return accessFailure(error); }
}
