export type LoginFailureCode = 'popup_blocked' | 'cancelled' | 'timeout' | 'callback' | 'restore';
export type LoginFailure = { kind: LoginFailureCode; code: string; message: string };

export function loginFailureFromCode(kind: string | null): LoginFailure {
  switch (kind) {
    case 'popup_blocked':
      return { kind, code: 'popup_blocked', message: '登录窗口被拦截，请允许弹出窗口后重试' };
    case 'cancelled':
      return { kind, code: 'cancelled', message: '登录已取消' };
    case 'timeout':
      return { kind, code: 'timeout', message: '登录等待已超时' };
    case 'restore':
      return { kind, code: '', message: '登录暂时不可用' };
    default:
      return { kind: 'callback', code: '', message: '登录未完成，请重试' };
  }
}

/** SDK error details are displayed as plain text; never copied to a URL or interpreted as HTML. */
export function loginFailure(error: unknown): LoginFailure {
  const fallback = loginFailureFromCode('callback');
  if (!error || typeof error !== 'object') return fallback;
  const code = 'error' in error && typeof error.error === 'string' ? error.error : '';
  const description = 'error_description' in error && typeof error.error_description === 'string' ? error.error_description : '';
  const message = description || ('message' in error && typeof error.message === 'string' ? error.message : '') || fallback.message;
  const kind = code === 'popup_open' ? 'popup_blocked' : loginFailureFromCode(code).kind;
  return { kind, code, message };
}
