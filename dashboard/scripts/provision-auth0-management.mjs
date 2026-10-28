import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH0_DOMAIN, management } from './lib/auth0-management.mjs';

const apply = process.argv.includes('--apply');
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
if (config.name !== 'eastmoney-dashboard') throw new Error('Unexpected target Worker');
const clientId = config.vars.AUTH0_MANAGEMENT_CLIENT_ID;
const audience = `https://${AUTH0_DOMAIN}/api/v2/`;
const requiredScopes = ['read:users', 'create:users', 'update:users', 'read:roles', 'update:roles'];
const client = management('get', `clients/${encodeURIComponent(clientId)}`);
if (client.client_id !== clientId || client.app_type !== 'non_interactive' || !client.client_secret) throw new Error('Existing site management application is unavailable');
const grants = management('get', `client-grants?client_id=${encodeURIComponent(clientId)}`).filter(grant => grant.audience === audience);
if (grants.length !== 1) throw new Error('Expected one existing Management API grant');
const grant = grants[0];
const missingScopes = requiredScopes.filter(scope => !grant.scope.includes(scope));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', clientId, worker: config.name, missingScopes, secretChanged: false }));
if (missingScopes.length) throw new Error('Selected management application lacks required scopes');
if (!apply) process.exit(0);

// Reuse an already-authorized credential. No client grant or user role is changed.
const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: client.client_secret, audience }),
});
if (!response.ok) throw new Error(`Management credential verification failed (${response.status})`);
const token = await response.json();
if (!token.access_token || requiredScopes.some(scope => !String(token.scope).split(' ').includes(scope))) throw new Error('Management token lacks required scopes');
console.log(JSON.stringify({ clientId, scopesVerified: true, credentialVerified: true, clientRotated: false }));

const directory = await mkdtemp(join(tmpdir(), 'eastmoney-auth0-version-'));
try {
  const secretFile = join(directory, 'secrets.json');
  await writeFile(secretFile, JSON.stringify({ AUTH0_MANAGEMENT_CLIENT_SECRET: client.client_secret }), { mode: 0o600 });
  // Stage code, Client ID and Secret together; the active version is untouched until deploy.
  const uploaded = spawnSync('pnpm', ['exec', 'wrangler', 'versions', 'upload', '--secrets-file', secretFile, '--tag', 'unified-identity'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const versionId = /Worker Version ID:\s*([a-f0-9-]{36})/i.exec(uploaded.stdout)?.[1];
  if (uploaded.status !== 0 || !versionId) throw new Error('Version staging failed; the current deployment has not been changed');
  console.log(JSON.stringify({ stagedVersion: versionId }));
  const deployed = spawnSync('pnpm', ['exec', 'wrangler', 'versions', 'deploy', `${versionId}@100%`, '--yes', '--message', 'Unify site identity and Auth0 management credential'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (deployed.status !== 0) throw new Error(`Version activation failed; staged version ${versionId} is retained for retry`);
  console.log(JSON.stringify({ deployedVersion: versionId, credentialsSwitchedAtomically: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
