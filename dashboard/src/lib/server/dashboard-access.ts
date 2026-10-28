import { AccessError, accessFailure } from './access.ts';
import { apiRequiresLogin, pageRequiresLogin, safeReturnTo } from '../auth-navigation.ts';
export { safeReturnTo } from '../auth-navigation.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function dashboardRequiresLogin(request: Request): boolean {
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname); }
  catch { throw new AccessError(403, '请求路径无效'); }
  if (path === '/auth/logout') return false;
  return !SAFE_METHODS.has(request.method)
    || pageRequiresLogin(path) || apiRequiresLogin(path);
}

export function dashboardAccessFailure(request: Request, error: unknown): Response {
  const path = new URL(request.url);
  if (error instanceof AccessError && error.status === 401 && request.method === 'GET'
    && request.headers.get('Accept')?.includes('text/html') && path.pathname !== '/auth/login') {
    return new Response(null, { status: 303, headers: {
      Location: `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(path.pathname + path.search))}`,
      'Cache-Control': 'no-store, private',
    } });
  }
  return accessFailure(error);
}

export function requireSameOrigin(request: Request): void {
  if (!SAFE_METHODS.has(request.method) && request.headers.get('Origin') !== new URL(request.url).origin) {
    throw new AccessError(403, '仅允许从本站提交操作');
  }
}
