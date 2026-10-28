import { Auth0Client, type Auth0ClientOptions } from '@auth0/auth0-spa-js';
import { decodeJwt } from 'jose';
import { publicSession, type ClientSessionData } from './identity.ts';
import { clientRequestPermission } from './route-permissions.ts';
import { safeReturnTo, pageRequiresLogin } from './auth-navigation.ts';
import { loginFailure, type LoginFailure } from './login-failure.ts';

let client: Auth0Client;
let token: string | null = null;
let snapshot: ClientSessionData = publicSession(null);
let rawFetch: typeof fetch;
let pending: Promise<ClientSessionData> | null = null;
let restored = false;
let restorationError: Error | null = null;
let callbackFailure: LoginFailure | null = null;
export function getLoginCallbackFailure() { return callbackFailure; }

/** JWT decoding is presentation only. Gateway validates it before this becomes a login. */
export function sessionFromJwt(jwt: string, permissions: string[], now = Date.now()): ClientSessionData {
  const claims = decodeJwt(jwt);
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string'
    || (typeof claims.role !== 'string' || !claims.role) || !Array.isArray(claims._roles) || !claims._roles.every(role => typeof role === 'string')
    || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new Error('登录令牌格式无效，请重新登录');
  return { user: { id: claims.sub, auth0Id: claims.sub, email: claims.email },
    account: { name: typeof claims.username === 'string' ? claims.username : '', department: typeof claims.department === 'string' ? claims.department : '' },
    _roles: claims._roles, role: claims.role, picture: typeof claims.picture === 'string' ? claims.picture : '',
    permissions, expiresAt: claims.exp };
}

export async function loadBearerSession(force = false): Promise<ClientSessionData> {
  if (restorationError && !force) throw restorationError;
  if (!force && restored && (!snapshot.user || snapshot.expiresAt! * 1000 > Date.now())) return snapshot;
  if (pending) return pending;
  pending = (async () => {
    token = null;
    snapshot = publicSession(null);
    let nextToken: string | undefined;
    try { nextToken = await client.getTokenSilently(force ? { cacheMode: 'off' } : {}); }
    catch (error) {
      if (error && typeof error === 'object' && 'error' in error && ['login_required', 'consent_required', 'interaction_required'].includes(String(error.error))) { restored = true; return snapshot; }
      throw new Error('登录状态暂时无法恢复，请重新登录');
    }
    if (!nextToken) { restored = true; return snapshot; }
    const response = await rawFetch('/auth/permissions', { headers: { Authorization: `Bearer ${nextToken}` }, cache: 'no-store', credentials: 'omit' });
    if (response.status === 401) { restored = true; return snapshot; }
    if (!response.ok) throw new Error('权限暂时无法读取，请稍后重试');
    const data = await response.json();
    if (!Array.isArray(data.permissions) || !data.permissions.every((value: unknown) => typeof value === 'string')) throw new Error('权限数据无效');
    snapshot = sessionFromJwt(nextToken, data.permissions);
    token = nextToken;
    restored = true;
    return snapshot;
  })().finally(() => { pending = null; });
  return pending;
}

/** Presentation availability only; Gateway remains the authority for every Data request. */
const publicDataPaths = new Set([
  'chinamoney/shibor', 'health', 'config', 'docs', 'redoc', 'openapi.json', 'omo', 'cfets', 'cfets-histories', 'bond-top-case',
  'futures-latest', 'margin', 'industry', 'trading-days', 'stock-summary', 'primary-issues', 'broker-bond-registrations',
  'today-trades', 'favorite-quotes', 'bond-infos', 'news', 'wechat-articles',
]);
function publicDataResource(path: string): boolean {
  return path.startsWith('/data/') && (publicDataPaths.has(path.slice('/data/'.length)) || /^\/data\/news\/[^/]+$/.test(path));
}

export function withBearer(fetcher: typeof fetch, origin: () => string, getToken: () => Promise<string | null>, isPublic: (url: URL, method: string) => boolean = () => false): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin());
    if (url.origin !== new URL(origin()).origin) return fetcher(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let accessToken: string | null = null;
    try { accessToken = await getToken(); }
    catch (error) {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (!isPublic(url, method)) throw error;
    }
    headers.delete('Authorization');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    return fetcher(input, { ...init, headers, credentials: 'omit' });
  };
}

export async function initializeBearer(fetcher: typeof fetch, host: Window = window, createClient: (options: Auth0ClientOptions) => Auth0Client = options => new Auth0Client(options)): Promise<void> {
  token = null;
  restored = false;
  restorationError = null;
  callbackFailure = null;
  snapshot = publicSession(null);
  rawFetch = fetcher;
  client = createClient({ domain: 'auth.hasbai.xyz', clientId: '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m',
    cacheLocation: 'memory', useRefreshTokens: false,
    authorizationParams: { audience: 'https://eastmoney.hasbai.xyz/', organization: 'org_6yvoRRCkzk3eGkBS',
      scope: 'openid profile email', redirect_uri: host.location.origin + '/auth/callback' } });
  const url = new URL(host.location.href);
  if (url.pathname === '/auth/callback') {
    try {
      if (!url.searchParams.has('state') || (!url.searchParams.has('code') && !url.searchParams.has('error'))) throw new Error('登录回调无效');
      const result = await client.handleRedirectCallback();
      host.history.replaceState({}, '', safeReturnTo(result.appState?.returnTo ?? '/'));
    } catch (error) {
      const failure = loginFailure(error);
      callbackFailure = failure;
      restorationError = new Error(failure.message);
      const appState = error && typeof error === 'object' && 'appState' in error ? error.appState : null;
      const returnTo = appState && typeof appState === 'object' && 'returnTo' in appState && typeof appState.returnTo === 'string' ? safeReturnTo(appState.returnTo) : '/';
      host.history.replaceState({}, '', '/auth/login?error=' + failure.kind + '&returnTo=' + encodeURIComponent(returnTo));
    }
  }
  host.fetch = withBearer(fetcher, () => host.location.origin, async () => {
    if (restorationError) throw restorationError;
    await loadBearerSession();
    return token;
  }, (requestUrl, method) => ['GET', 'HEAD'].includes(method) && (clientRequestPermission(requestUrl, method) === 'public'
    || publicDataResource(requestUrl.pathname) || requestUrl.pathname.startsWith('/_app/') || requestUrl.pathname.startsWith('/assets/')));
  if (!restorationError) {
    try { await loadBearerSession(); } catch (error) { restorationError = error instanceof Error ? error : new Error('登录状态暂时无法恢复'); }
  }
  if (!snapshot.user && pageRequiresLogin(host.location.pathname)) {
    const returnTo = host.location.pathname + host.location.search + host.location.hash;
    if (restorationError) host.location.assign('/auth/login?error=restore&returnTo=' + encodeURIComponent(safeReturnTo(returnTo)));
    else await loginRedirect(returnTo);
    await new Promise<void>(() => {}); // Leave initial protected data requests suspended until redirect.
  }
}

export function loginRedirect(returnTo = '/') {
  callbackFailure = null;
  return client.loginWithRedirect({ appState: { returnTo: safeReturnTo(returnTo) } });
}
export async function loginPopup(popup?: Window) {
  callbackFailure = null;
  await client.loginWithPopup({}, popup ? { popup } : undefined);
  token = null;
  restored = false;
  restorationError = null;
  callbackFailure = null;
  snapshot = publicSession(null);
  return loadBearerSession();
}
export function logoutBearer() {
  token = null;
  restored = true;
  snapshot = publicSession(null);
  return client.logout({ logoutParams: { returnTo: window.location.origin } });
}
