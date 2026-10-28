// Historical migration fixture. Production Actions live in auth0/actions.
exports.onExecutePostLogin = async (event, api) => {
  if (event.client.client_id !== event.secrets.EASTMONEY_CLIENT_ID) return;
  const metadata = event.user.app_metadata || {};
  const legacy = metadata.migrated_from === 'neon'
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(metadata.neon_auth_user_id || '')
    && event.user.user_id === `auth0|${metadata.neon_auth_user_id}`
    && metadata.neon_email === String(event.user.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@18\.cn$/i.test(event.user.email || '')) return api.access.deny('仅允许使用 18.cn 邮箱登录');
  if (!event.user.email_verified && !legacy) return api.access.deny('请先验证注册邮箱，再返回登录');
  api.idToken.setCustomClaim('eastmoney_user_id', event.user.user_id);
};
