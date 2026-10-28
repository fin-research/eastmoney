// Historical pre-0032 authentication fixture; never imported by production code.
// @ts-check
import { PERMISSION_CODES } from './permissions.js';
import { NeonAuthApiError } from './neon-auth-client.js';

// Deployment-wide service credentials only: never cache user identity or in-flight I/O here.
/** @type {Map<string, { token: string, secret: string, expiresAt: number }>} */
const serviceTokens = new Map();

/** @param {any} user */
export function auth0ProfileCanLogin(user) {
  const metadata = user?.app_metadata ?? {};
  const email = String(user?.email ?? '').trim().toLowerCase();
  const migrated = metadata.migrated_from === 'neon' && user?.user_id === `auth0|${metadata.neon_auth_user_id}`
    && metadata.neon_email === email && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(metadata.neon_auth_user_id ?? '');
  return /^[^@\s]+@18\.cn$/.test(email) && !user?.blocked && (user?.email_verified === true || migrated);
}

/** @param {{ domain: string, clientId: string, clientSecret: string, roleIds: Record<string,string>, fetchImpl?: typeof fetch }} config */
export function createAuth0ManagementClient(config) {
  const fetcher = config.fetchImpl ?? fetch;
  if (!/^[a-z0-9.-]+\.auth0\.com$/.test(config.domain) || !config.clientId || !config.clientSecret) {
    throw new NeonAuthApiError(503, 'Auth0 管理服务未配置', 'AUTH0_UNAVAILABLE');
  }
  const origin = `https://${config.domain}`;
  const cacheKey = `${config.domain}:${config.clientId}`;
  /** @type {Promise<string> | undefined} */
  let tokenRequest;

  /** @param {string} url @param {RequestInit} init */
  async function send(url, init) {
    let response;
    // workerd supports manual/follow only. Reject 3xx here without forwarding credentials.
    try { response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch {
      console.warn(JSON.stringify({ event: 'auth0_request_failed', phase: url.includes('/oauth/token') ? 'token' : 'management', reason: 'network' }));
      throw new NeonAuthApiError(503, 'Auth0 暂时不可用', 'AUTH0_UNAVAILABLE');
    }
    if (response.status === 401) serviceTokens.delete(cacheKey);
    if (!response.ok) {
      console.warn(JSON.stringify({ event: 'auth0_request_failed', phase: url.includes('/oauth/token') ? 'token' : 'management', status: response.status }));
      throw new NeonAuthApiError(response.status < 400 || response.status >= 500 || [401, 403, 429].includes(response.status) ? 503 : response.status, 'Auth0 操作失败', 'AUTH0_REQUEST_FAILED');
    }
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('limit'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new NeonAuthApiError(503, 'Auth0 响应无效', 'AUTH0_RESPONSE_INVALID'); }
  }

  async function token() {
    const cached = serviceTokens.get(cacheKey);
    if (cached && cached.secret === config.clientSecret && cached.expiresAt > Date.now()) return cached.token;
    tokenRequest ??= send(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.clientId,
        client_secret: config.clientSecret, audience: `${origin}/api/v2/` }),
    }).then((value) => {
      if (!value?.access_token) throw new NeonAuthApiError(503, 'Auth0 管理授权不可用');
      const token = String(value.access_token);
      const lifetime = Number(value.expires_in);
      if (serviceTokens.size >= 4) serviceTokens.clear();
      serviceTokens.set(cacheKey, { token, secret: config.clientSecret,
        expiresAt: Date.now() + (Math.min(Number.isFinite(lifetime) ? lifetime : 300, 86400) - 60) * 1000 });
      return token;
    });
    return tokenRequest;
  }

  /** @param {string} path @param {string} [method] @param {unknown} [body] */
  async function request(path, method = 'GET', body) {
    return send(`${origin}/api/v2/${path}`, { method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** @param {string} path */
  async function list(path) {
    const rows = [];
    for (let page = 0; page < 20; page++) {
      const result = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new NeonAuthApiError(503, 'Auth0 列表响应无效');
      rows.push(...result);
      if (result.length < 100) return rows;
    }
    throw new NeonAuthApiError(503, 'Auth0 列表超出处理范围');
  }

  /** @param {string} role */
  function roleId(role) {
    const id = config.roleIds[role];
    if (!id || !['admin', 'handler', 'reviewer'].includes(role)) throw new NeonAuthApiError(503, 'Auth0 角色映射未配置');
    return encodeURIComponent(id);
  }
  /** @param {Array<{resource_server_identifier:string,permission_name:string}>} rows */
  const permissionCodes = (rows) => [...new Set(rows.filter((row) => row.resource_server_identifier === 'https://eastmoney.hasbai.xyz/financing'
    && PERMISSION_CODES.includes(row.permission_name)).map((row) => row.permission_name))].sort();

  return {
    request,
    async directory() {
      const [users, memberships] = await Promise.all([
        list('users?search_engine=v3&q=' + encodeURIComponent('identities.connection:"eastmoney-email"')),
        Promise.all(Object.entries(config.roleIds).map(async ([role, id]) => ({ role, users: await list(`roles/${encodeURIComponent(id)}/users`) }))),
      ]);
      return users.map((user) => {
        const roles = memberships.filter((group) => group.users.some((member) => member.user_id === user.user_id)).map((group) => group.role);
        return { id: user.user_id, role: roles.length === 1 ? roles[0] : null,
          active: auth0ProfileCanLogin(user) && user.app_metadata?.financing_enabled !== false && roles.length === 1 };
      });
    },
    /** @param {string} id */
    async removeFinancingRoles(id) {
      const path = `users/${encodeURIComponent(id)}/roles`;
      const roles = (await list(path)).filter((role) => Object.values(config.roleIds).includes(role.id)).map((role) => role.id);
      if (roles.length) await request(path, 'DELETE', { roles });
    },
    /** @param {string} id */
    async authorization(id) {
      const path = `users/${encodeURIComponent(id)}`;
      const [user, roles, permissions] = await Promise.all([request(path), list(`${path}/roles`), list(`${path}/permissions`)]);
      const matches = Object.entries(config.roleIds).filter(([, roleId]) => roles.some((role) => role.id === roleId));
      if (!auth0ProfileCanLogin(user) || user?.app_metadata?.financing_enabled === false || matches.length !== 1 || !matches[0]) return null;
      return { role: matches[0][0], permissions: permissionCodes(permissions), email: String(user.email) };
    },
    /** @param {string} role */
    async rolePermissions(role) { return permissionCodes(await list(`roles/${roleId(role)}/permissions`)); },
    /** @param {string} role @param {string[]} codes */
    async saveRolePermissions(role, codes) {
      if (codes.some((code) => !PERMISSION_CODES.includes(code))) throw new NeonAuthApiError(400, '权限类型无效');
      const path = `roles/${roleId(role)}/permissions`;
      const existing = permissionCodes(await list(path));
      const objects = (/** @type {string[]} */ values) => values.map((permission_name) => ({ permission_name, resource_server_identifier: 'https://eastmoney.hasbai.xyz/financing' }));
      const removed = existing.filter((code) => !codes.includes(code));
      const added = codes.filter((code) => !existing.includes(code));
      // Revoke before granting so a partial failure cannot widen access.
      if (removed.length) await request(path, 'DELETE', { permissions: objects(removed) });
      if (added.length) await request(path, 'POST', { permissions: objects(added) });
    },
    /** @param {string} id @param {string} role */
    async setRole(id, role) {
      const target = config.roleIds[role]; roleId(role);
      const path = `users/${encodeURIComponent(id)}/roles`;
      const assigned = await list(path);
      const previous = assigned.filter((item) => Object.values(config.roleIds).includes(item.id) && item.id !== target).map((item) => item.id);
      if (previous.length) await request(path, 'DELETE', { roles: previous });
      if (!assigned.some((item) => item.id === target)) await request(path, 'POST', { roles: [target] });
    },
  };
}
