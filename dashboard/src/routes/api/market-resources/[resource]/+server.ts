import type { RequestHandler } from './$types';
import { publicMarketRequest } from '$lib/server/public-market-resources';

export const GET: RequestHandler = async ({ params, url, platform }) => {
  let request: Request;
  try {
    request = publicMarketRequest(params.resource, url.searchParams);
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : '参数无效' }, { status: 400 });
  }
  if (!platform?.env.DATA) return Response.json({ detail: '市场数据服务暂时不可用' }, { status: 503 });
  try {
    const response = await platform.env.DATA.fetch(request);
    // Cookies, credentials and upstream redirects are never forwarded.
    if (response.status >= 300 && response.status < 400) return Response.json({ detail: '市场数据服务暂时不可用' }, { status: 503 });
    return new Response(response.body, { status: response.status, headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    } });
  } catch {
    return Response.json({ detail: '市场数据读取失败，请稍后重试' }, { status: 503 });
  }
};
