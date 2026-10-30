// Shared post-login profile collection and access token claims.

const EM_ORGANIZATION_ID = 'org_6yvoRRCkzk3eGkBS';
const setLoginClaims = (event, api) => {
  if (event.user.blocked) return api.access.deny('用户被封禁');

  let dbRole = "authenticated";
  let roles = event.authorization?.roles ?? [];
  if (event.resource_server?.identifier === "https://financial.hasbai.xyz/api" && roles.includes("superadmin")) {
    dbRole = "superadmin";
  }
  api.accessToken.setCustomClaim("role", dbRole);
  api.accessToken.setCustomClaim("_roles", roles);
  api.accessToken.setCustomClaim("email", event.user.email);
  api.accessToken.setCustomClaim("username", profileName(event.user));

  if (event.organization?.id === EM_ORGANIZATION_ID) {
    api.accessToken.setCustomClaim('department', event.user.user_metadata?.department);
    api.accessToken.setCustomClaim('picture', event.user.picture);
  };

  if (event.connection?.name?.includes('email') && !event.user.email_verified) {
    return api.access.deny('请先验证注册邮箱，再返回登录');
  };
  if (['tpc_a7WD9gnnwfLwzjTcG3aN8m', 'tpc_2WkMuCZoYq49waTvQZjJHK', 'tpc_mJaDePAHohZSgFrpLBfWny'].includes(event.client.client_id)) {
    if (event.organization?.id !== EM_ORGANIZATION_ID || event.connection?.name !== 'eastmoney-email'
      || !event.user.email_verified || !/^[^@\s]+@18\.cn$/i.test(event.user.email ?? '')) {
      return api.access.deny('请使用东方财富组织的已验证 18.cn 账号登录');
    }
    api.accessToken.setCustomClaim('https://eastmoney.hasbai.xyz/identity', {
      username: profileName(event.user) || event.user.email,
      email: event.user.email,
      role: dbRole,
      _roles: roles,
      department: event.user.user_metadata?.department || '',
      picture: event.user.picture || '',
    });
  }

};

const profileName = (user) => [user.name, user.username, user.nickname].map(v => v?.trim()).find(Boolean);

const needsProfile = (event) => event.organization?.id === EM_ORGANIZATION_ID
  && event.connection?.name?.includes('email')
  && !(event.user.name && event.user.user_metadata?.department);
const clean = (value, limit) => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= limit && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim() : null;

exports.onExecutePostLogin = async (event, api) => {
  if (event.user.blocked) return api.access.deny('用户被封禁');
  if (needsProfile(event)) {
    if (!api.redirect.canRedirect()) return api.access.deny('请在浏览器中登录并填写姓名、部门');
    return api.prompt.render(event.secrets.PROFILE_FORM_ID, { fields: { name: '', department: '' } });
  }
  return setLoginClaims(event, api);
};

exports.onContinuePostLogin = async (event, api) => {
  if (event.user.blocked) return api.access.deny('用户被封禁');
  if (event.organization?.id !== EM_ORGANIZATION_ID || !event.connection?.name?.includes('email')
    || event.prompt?.id !== event.secrets.PROFILE_FORM_ID) {
    return api.access.deny('注册资料表单无效，请重新登录');
  }
  const name = clean(event.prompt.fields?.name, 50);
  const department = clean(event.prompt.fields?.department, 100);
  if (!name || !department) return api.access.deny('请填写有效的姓名和部门后重新登录');
  const origin = 'https://hasbai.eu.auth0.com';
  let profile;
  try {
    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: event.secrets.PROFILE_CLIENT_ID,
        client_secret: event.secrets.PROFILE_CLIENT_SECRET, audience: `${origin}/api/v2/` }),
    });
    if (!tokenResponse.ok) throw new Error('token');
    const token = await tokenResponse.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('token');
    const response = await fetch(`${origin}/api/v2/users/${encodeURIComponent(event.user.user_id)}`, {
      method: 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, user_metadata: { department } }),
    });
    if (!response.ok) throw new Error('profile');
    profile = await response.json();
    if (profile.name !== name || profile.user_metadata?.department !== department) throw new Error('profile');
  } catch {
    return api.access.deny('暂时无法保存注册资料，请稍后重新登录');
  }
  return setLoginClaims({ ...event, user: { ...event.user, name: profile.name,
    user_metadata: { ...event.user.user_metadata, ...profile.user_metadata } } }, api);
};
