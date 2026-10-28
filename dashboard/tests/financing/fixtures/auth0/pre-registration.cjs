// Historical migration fixture. Production Actions live in auth0/actions.
exports.onExecutePreUserRegistration = async (event, api) => {
  if (event.connection.name !== 'eastmoney-email') return;
  if (!/^[^@\s]+@18\.cn$/i.test(String(event.user.email || '').trim())) {
    api.access.deny('email_domain_not_allowed', '仅支持使用 18.cn 邮箱注册');
  }
};
