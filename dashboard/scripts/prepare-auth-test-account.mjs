import { createAuth0ManagementClient } from './lib/auth0-management-client.mjs';
import { auth0DeployCredentials } from './lib/auth0-deploy-config.mjs';

// User-authorized fixture maintenance. Default is read-only; --apply changes
// only the uniquely identified test account, without roles/password changes.
const email = 'test@18.cn';
const apply = process.argv.includes('--apply');
try {
  const config = await auth0DeployCredentials();
  const manager = createAuth0ManagementClient({ domain: config.AUTH0_DOMAIN, clientId: config.AUTH0_CLIENT_ID, clientSecret: config.AUTH0_CLIENT_SECRET });
  const request = (method, path, body) => manager.request(path, method, body);
  const matches = await request('GET', `users-by-email?email=${encodeURIComponent(email)}`);
  if (!Array.isArray(matches) || matches.length !== 1) throw new Error('Expected exactly one test account');
  const account = matches[0];
  if (account.email !== email || !/^auth0\|\S+$/.test(account.user_id)
    || !account.identities?.some(item => item.connection === 'eastmoney-email')) throw new Error('Test account identity mismatch');
  const patch = { email_verified: true, name: '测试账号', nickname: '测试账号',
    user_metadata: { name: '测试账号', department: '测试' },
    app_metadata: { eastmoney_signup_profile_pending: false } };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', email, name: patch.name, department: patch.user_metadata.department, emailVerified: true, profilePending: false }));
  if (apply) {
    await request('PATCH', `users/${encodeURIComponent(account.user_id)}`, patch);
    const result = await request('GET', `users/${encodeURIComponent(account.user_id)}`);
    if (result.email !== email || result.email_verified !== true || result.name !== patch.name
      || result.user_metadata?.department !== '测试' || result.app_metadata?.eastmoney_signup_profile_pending !== false) throw new Error('Test account verification failed');
    console.log(JSON.stringify({ verified: true, email, emailVerified: true, name: result.name, department: result.user_metadata.department }));
  }
} catch (error) {
  // No raw HTTP response or credential is included in this error.
  console.error(JSON.stringify({ prepared: false, message: error.message })); process.exitCode = 1;
}
