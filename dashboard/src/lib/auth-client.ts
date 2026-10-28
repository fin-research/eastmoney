import { clientRequestPermission, pagePermission } from './route-permissions.ts';
import { publicSession, type ClientSessionData } from './identity.ts';
import type { ClientSession } from './client-session';
import type { BeforeNavigate } from '@sveltejs/kit';

export class LoginRequiredError extends Error {
  constructor() { super('请先登录'); }
}

type Interaction = {
  session: ClientSession;
  login: (returnTo: string) => Promise<boolean>;
  error: (message: string) => void;
};
// Installed by the mounted root layout, never during SSR.
let interaction: Interaction | undefined;
let loggingIn = 0;
export function installAuthInteraction(value: Interaction): () => void {
  interaction = value;
  return () => { if (interaction === value) interaction = undefined; };
}
export function isLoginRedirecting(): boolean { return loggingIn > 0; }
export async function requestLogin(returnTo = '/'): Promise<boolean> {
  if (!interaction) return false;
  loggingIn++;
  try { return await interaction.login(returnTo); }
  finally { loggingIn--; }
}

export function sessionAllows(session: ClientSessionData, permission: string | undefined): boolean {
  return permission === 'public' || !!session.user && !!permission
    && (permission === 'login' || permission === 'admin' && session._roles.includes('admin') || session.permissions.includes(permission));
}

export async function requireClientPermission(permission: string, returnTo: string, state: ClientSession): Promise<boolean> {
  let session = await state.load();
  if (!session.user) {
    if (!await requestLogin(returnTo)) return false;
    session = state.current() ?? await state.load(true);
  }
  if (!sessionAllows(session, permission)) {
    interaction?.error('当前角色无权执行此操作');
    return false;
  }
  return true;
}
export function requireClientLogin(returnTo: string, state: ClientSession): Promise<boolean> {
  return requireClientPermission('login', returnTo, state);
}

/** Preflight all registered fetch/actions and recover expired sessions without a document navigation. */
export function withAuthInteraction(fetcher: typeof fetch, currentUrl: () => string): typeof fetch {
  return async (input, init) => {
    const current = new URL(currentUrl());
    const requested = new URL(input instanceof Request ? input.url : String(input), current);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    // The snapshot request must bypass interception to avoid recursive login.
    if (requested.origin !== current.origin || requested.pathname.startsWith('/auth/')) return fetcher(input, init);
    const ui = interaction;
    const returnTo = current.pathname + current.search + current.hash;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const isData = requested.pathname.endsWith('/__data.json');
    const failure = (status: number, detail: string, code: string) => {
      if (isData) return Response.json({ type: 'redirect', location: returnTo });
      if (headers.get('x-sveltekit-action') === 'true') return Response.json({ type: 'failure', status }, { status });
      return Response.json({ detail, code }, { status });
    };
    const permission = clientRequestPermission(requested, method);
    if (ui && permission && permission !== 'public') {
      if (!await requireClientPermission(permission, returnTo, ui.session)) {
        return failure(403, '操作未执行：请登录并确认权限', 'ACCESS_DENIED');
      }
    }
    let response = await fetcher(input, init);
    let loginRequired = response.status === 401;
    // Older/newer Gateway versions both retain SvelteKit's redirect protocol.
    // Consume only auth redirects; other application redirects remain untouched.
    if (requested.pathname.endsWith('/__data.json') && response.ok) {
      const value = await response.clone().json().catch(() => null);
      loginRequired ||= value?.type === 'redirect' && typeof value.location === 'string' && value.location.startsWith('/auth/login?');
    }
    if (loginRequired && ui) {
      ui.session.seed(publicSession(null));
      const loggedIn = await requestLogin(returnTo);
      if (loggedIn && ['GET', 'HEAD'].includes(method)) {
        response = await fetcher(input, init); // exactly one read retry
        const retryData = isData && response.ok ? await response.clone().json().catch(() => null) : null;
        if (response.status === 401 || (retryData?.type === 'redirect' && retryData.location?.startsWith('/auth/login?'))) {
          ui.error('登录状态未恢复，请稍后重试');
          return failure(401, '登录状态未恢复，请稍后重试', 'LOGIN_REQUIRED');
        }
      } else {
        if (loggedIn) ui.error('登录已恢复，请重新提交，原输入已保留');
        // Enhanced forms must not interpret a 401 as a full-page login redirect.
        return failure(401, loggedIn ? '登录已恢复，请重新提交' : '请先登录', 'LOGIN_REQUIRED');
      }
    }
    if (response.status === 403 && ui) {
      const error = await response.clone().json().catch(() => null);
      ui.error(error?.detail || '当前角色无权执行此操作');
      // The server has the current permission table. Keep the login snapshot
      // until the user explicitly refreshes login state; never retry a denied write.
      if (isData || headers.get('x-sveltekit-action') === 'true') return failure(403, error?.detail || '当前角色无权执行此操作', 'ACCESS_DENIED');
    }
    return response;
  };
}

export function createClientNavigationGuard(state: ClientSession, options: {
  origin: () => string;
  navigate: (url: URL) => Promise<unknown>;
  error: (message: string) => void;
  login?: (returnTo: string) => Promise<boolean> | void;
}) {
  let navigation = 0;
  return ({ to, cancel }: BeforeNavigate): void => {
    const attempt = ++navigation;
    if (!to || to.url.origin !== options.origin() || !to.route.id) return;
    const permission = pagePermission(to.url.pathname, to.route.id);
    if (permission === 'public') return;
    const cached = state.current();
    if (cached && sessionAllows(cached, permission)) return;
    cancel();
    const resume = async (session: ClientSessionData) => {
      if (attempt !== navigation) return;
      if (!session.user) {
        if (!await (options.login ?? requestLogin)(to.url.pathname + to.url.search + to.url.hash)) return;
        session = state.current() ?? await state.load(true);
      }
      if (attempt !== navigation) return;
      if (!sessionAllows(session, permission)) { options.error('当前角色无权访问该页面'); return; }
      await options.navigate(to.url);
    };
    // Cached decisions are synchronous, so denied clicks are stopped before preloads/navigation.
    void (cached ? resume(cached) : state.load().then(resume)).catch(error => {
      if (attempt === navigation) options.error(error.message);
    });
  };
}
