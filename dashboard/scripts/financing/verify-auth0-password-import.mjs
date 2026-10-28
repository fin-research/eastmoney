import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { management } from '../lib/auth0-management.mjs';
import { auth0ImportUser } from './lib/auth0-migration.mjs';

const directory = process.env.AUTH0_MIGRATION_DIR;
if (!directory) throw new Error('Set AUTH0_MIGRATION_DIR');
const manager = JSON.parse(await readFile(`${directory}/management.json`, 'utf8'));
const origin = `https://${manager.domain}`;
const suffix = randomBytes(4).toString('hex');
const fixtureClient = management('post', 'clients', {
  name: `eastmoney password migration check ${suffix}`, app_type: 'regular_web',
  grant_types: ['http://auth0.com/oauth/grant-type/password-realm'], token_endpoint_auth_method: 'client_secret_post',
});
const connection = management('post', 'connections', {
  name: `eastmoney-migration-check-${suffix}`, strategy: 'auth0',
  options: { passwordPolicy: 'good', disable_signup: true, requires_username: false },
  enabled_clients: [fixtureClient.client_id],
});
const fixtures = [
  { kind: 'ascii', password: `Auth0-${randomBytes(18).toString('hex')}!A2` },
  { kind: 'unicode_nfkc', password: `Ａｕｔｈ０-${randomBytes(18).toString('hex')}Cafe\u0301!A2` },
];
const users = fixtures.map((fixture) => {
  const salt = randomBytes(16).toString('hex');
  const password = `${salt}:${scryptSync(fixture.password.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
  const row = { id: randomUUID(), name: 'Synthetic migration verification', email: `migration-${fixture.kind}-${suffix}@18.cn`, password };
  fixture.email = row.email;
  return auth0ImportUser(row);
});
const tokenResponse = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'client_credentials', client_id: manager.client_id, client_secret: manager.client_secret, audience: `${origin}/api/v2/` }) });
const token = await tokenResponse.json();
if (!token.access_token) throw new Error('Management token unavailable');
const form = new FormData();
form.set('connection_id', connection.id); form.set('upsert', 'false'); form.set('send_completion_email', 'false');
form.set('users', new Blob([JSON.stringify(users)], { type: 'application/json' }), 'synthetic-users.json');
const response = await fetch(`${origin}/api/v2/jobs/users-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}` }, body: form });
const job = await response.json();
if (!response.ok || !job.id) throw new Error(`Synthetic import failed (${response.status})`);
let status;
for (let attempt = 0; attempt < 60; attempt++) {
  const result = await fetch(`${origin}/api/v2/jobs/${job.id}`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  status = await result.json();
  if (status.status === 'completed' || status.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
const results = [];
if (status.status === 'completed') {
  for (const fixture of fixtures) {
    const result = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'http://auth0.com/oauth/grant-type/password-realm', client_id: fixtureClient.client_id,
        client_secret: fixtureClient.client_secret, realm: connection.name, username: fixture.email, password: fixture.password, scope: 'openid email' }) });
    const body = await result.json();
    results.push({ kind: fixture.kind, accepted: result.ok && Boolean(body.id_token), status: result.status, error: body.error });
  }
}
await writeFile(`${directory}/password-verification.json`, JSON.stringify({ connectionId: connection.id, clientId: fixtureClient.client_id, jobId: job.id, importStatus: status.status, results }), { mode: 0o600 });
console.log(JSON.stringify({ importStatus: status.status, results, fixtureConnection: connection.id, fixtureClient: fixtureClient.client_id }));
