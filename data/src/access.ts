/** Gateway verdict error consumed by GraphQL; authentication lives in Gateway. */
export class AccessError extends Error {
  constructor(readonly status: 401 | 403 | 503, message: string) { super(message); }
}
export function accessFailure(error: unknown): Response {
  const failure = error instanceof AccessError ? error : new AccessError(503, '网关上下文不可用');
  return Response.json({ detail: failure.message, code: failure.status === 401 ? 'LOGIN_REQUIRED' : 'ACCESS_DENIED', loginUrl: '/auth/login' }, {
    status: failure.status, headers: { 'Cache-Control': 'no-store' },
  });
}
