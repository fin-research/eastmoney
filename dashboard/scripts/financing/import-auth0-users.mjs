import { readFile, writeFile } from 'node:fs/promises';

const directory = process.env.AUTH0_MIGRATION_DIR;
if (!directory) throw new Error('Set AUTH0_MIGRATION_DIR');
const manager = JSON.parse(await readFile(`${directory}/management.json`, 'utf8'));
const connection = JSON.parse(await readFile(`${directory}/connection.json`, 'utf8'));
const users = JSON.parse(await readFile(`${directory}/users.json`, 'utf8'));
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'plan', users: users.length, connection: connection.name, upsert: false, emails: false }));
  process.exit(0);
}
if (!process.argv.includes('--confirmed-compatible-passwords')) throw new Error('Confirm NFKC password compatibility before importing');
const verification = JSON.parse(await readFile(`${directory}/password-verification.json`, 'utf8'));
if (!verification.results?.some((result) => result.kind === 'ascii' && result.accepted)) throw new Error('Synthetic password import verification has not passed');
const origin = `https://${manager.domain}`;
const tokenResponse = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'client_credentials', client_id: manager.client_id, client_secret: manager.client_secret, audience: `${origin}/api/v2/` }) });
const token = await tokenResponse.json();
if (!token.access_token) throw new Error('Management token unavailable');
async function api(path, method = 'GET', body) {
  const response = await fetch(`${origin}/api/v2/${path}`, { method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Auth0 ${method} ${path.split('?')[0]} failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
let job;
try { job = JSON.parse(await readFile(`${directory}/import-job.json`, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!job) {
  const form = new FormData();
  form.set('connection_id', connection.id); form.set('upsert', 'false'); form.set('send_completion_email', 'false');
  form.set('users', new Blob([JSON.stringify(users)], { type: 'application/json' }), 'users.json');
  const response = await fetch(`${origin}/api/v2/jobs/users-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}` }, body: form });
  job = await response.json();
  if (!response.ok || !job.id) throw new Error(`User import failed (${response.status})`);
  await writeFile(`${directory}/import-job.json`, JSON.stringify({ id: job.id, connection_id: connection.id }), { mode: 0o600 });
}
if (job.connection_id && job.connection_id !== connection.id) throw new Error('Saved import job targets another connection');
let status;
for (let attempt = 0; attempt < 90; attempt++) {
  status = await api(`jobs/${job.id}`);
  if (status.status === 'completed' || status.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (status.status !== 'completed' || status.summary?.failed > 0) throw new Error('User import did not complete cleanly');
const verified = [];
for (const source of users) {
  const userId = `auth0|${source.user_id}`;
  const target = await api(`users/${encodeURIComponent(userId)}`);
  if (target.email !== source.email || target.email_verified !== source.email_verified
    || Boolean(target.blocked) !== source.blocked || target.app_metadata?.neon_auth_user_id !== source.user_id
    || !target.identities?.some((identity) => identity.connection === connection.name)) throw new Error('Imported account reconciliation failed');
  const roleId = manager.role_ids[source.app_metadata.neon_role];
  if (source.app_metadata.financing_person_id) {
    if (!roleId) throw new Error('Original financing role is unmapped');
    await api(`users/${encodeURIComponent(userId)}/roles`, 'POST', { roles: [roleId] });
    const assigned = await api(`users/${encodeURIComponent(userId)}/roles`);
    if (assigned.filter((role) => Object.values(manager.role_ids).includes(role.id)).length !== 1
      || !assigned.some((role) => role.id === roleId)) throw new Error('Imported role reconciliation failed');
    const permissions = await api(`users/${encodeURIComponent(userId)}/permissions?per_page=100`);
    const actual = permissions.filter((permission) => permission.resource_server_identifier === 'https://eastmoney.hasbai.xyz/financing').map((permission) => permission.permission_name).sort();
    const matrix = JSON.parse(await readFile(`${directory}/role-permissions.json`, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify([...matrix[source.app_metadata.neon_role]].sort())) throw new Error('Imported permissions do not match the original role');
  }
  verified.push({ userId, personId: source.app_metadata.financing_person_id, role: source.app_metadata.neon_role });
}
const receipt = { jobId: job.id, connectionId: connection.id, verifiedUsers: verified.length, identities: verified,
  roles: Object.fromEntries(Object.keys(manager.role_ids).map((role) => [role, verified.filter((user) => user.role === role).length])) };
await writeFile(`${directory}/import-receipt.json`, JSON.stringify(receipt), { mode: 0o600 });
console.log(JSON.stringify({ jobId: receipt.jobId, verifiedUsers: receipt.verifiedUsers, roles: receipt.roles, passwordsReset: 0 }));
