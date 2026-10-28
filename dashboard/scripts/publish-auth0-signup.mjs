throw new Error('Retired pre-Gateway command. Signup profile Auth0 configuration is owned by Gateway; use the Gateway Auth0 deployment workflow.');

import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH0_DOMAIN, LOGIN_ACTION_ID, management } from './lib/auth0-management.mjs';

const apply = process.argv.includes('--apply');
const domain = process.argv.find((arg) => arg.startsWith('--login-domain='))?.split('=')[1];
const clientId = '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m';
const registrationId = 'aa087b15-bc91-4a86-9533-1e4e0f6f4525';
const previousRegistrationVersion = 'a7f0c1b4-f975-4c5f-a3e8-7682297f1b1d';
const load = (file) => readFile(new URL(`../auth0/${file}`, import.meta.url), 'utf8');
const [formJson, registrationCode, profileCode] = await Promise.all([
  load('branding/signup-profile-form.json'), load('actions/eastmoney-registration.cjs'), load('actions/eastmoney-signup-profile.cjs'),
]);
const formDefinition = JSON.parse(formJson);
const domains = management('get', 'custom-domains');
const ready = domains.some((item) => item.domain === domain && item.status === 'ready');
console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', tenant: AUTH0_DOMAIN, clientId,
  loginDomain: domain ?? null, domainReady: ready, fields: ['email', 'password', 'name', 'department'],
  profile: { name: 'name + nickname', department: 'user_metadata.department' } }));
if (!apply) process.exit(0);
if (!ready) throw new Error('Configure and verify the approved custom domain before applying signup fields');
if (management('get', 'prompts').universal_login_experience !== 'new') throw new Error('Expected New Universal Login');
const registration = management('get', `actions/actions/${registrationId}`);
if (registration.deployed_version?.id !== previousRegistrationVersion && registration.code !== registrationCode) throw new Error('Registration Action changed; review the new version');
if (registration.code !== registration.deployed_version?.code && registration.code !== registrationCode) throw new Error('Preserve the unrelated registration draft');
const bindingsPath = 'actions/triggers/post-login/bindings';
const previousBindings = management('get', bindingsPath).bindings;
if (!previousBindings.some((item) => item.action.id === LOGIN_ACTION_ID)) throw new Error('Expected the existing email-verification Action binding');
if (!management('get', 'actions/triggers/pre-user-registration/bindings').bindings.some((item) => item.action.id === registrationId)) throw new Error('Expected the existing registration Action binding');
const previousForms = management('get', 'forms');
const matchingForms = previousForms.filter((item) => item.name === formDefinition.name);
if (matchingForms.length > 1) throw new Error('Ambiguous signup profile Form');
const previousForm = matchingForms.length ? management('get', `forms/${matchingForms[0].id}`) : null;
const backupDirectory = await mkdtemp(join(tmpdir(), 'eastmoney-auth0-signup-'));
await writeFile(join(backupDirectory, 'before.json'), JSON.stringify({ form: previousForm,
  registration: { id: registration.id, code: registration.code, deployedVersion: registration.deployed_version.id },
  bindings: previousBindings.map((item) => ({ id: item.action.id, display_name: item.display_name })) }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ backupDirectory }));

// The CLI's default grant lacks Form write scopes. Use a short-lived deployment
// client and remove it in finally; runtime profile credentials only update users.
const provisioner = management('post', 'clients', { name: 'eastmoney temporary Form deployment', app_type: 'non_interactive', grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_post' });
let form;
try {
  management('post', 'client-grants', { client_id: provisioner.client_id, audience: `https://${AUTH0_DOMAIN}/api/v2/`, scope: ['read:forms', 'create:forms', 'update:forms'] });
  const authorization = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: provisioner.client_id,
      client_secret: provisioner.client_secret, audience: `https://${AUTH0_DOMAIN}/api/v2/` }) });
  if (!authorization.ok) throw new Error('Form deployment authorization failed');
  const token = await authorization.json();
  if (typeof token.access_token !== 'string') throw new Error('Form deployment token is missing');
  const response = await fetch(`https://${AUTH0_DOMAIN}/api/v2/forms${previousForm ? `/${previousForm.id}` : ''}`, {
    method: previousForm ? 'PATCH' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(formDefinition),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Form publication failed (${response.status})`); }
  form = await response.json();
} finally { management('delete', `clients/${provisioner.client_id}`); }
const publishedForm = management('get', `forms/${form.id}`);
for (const key of ['name', 'languages', 'start', 'nodes', 'ending']) assert.deepEqual(publishedForm[key], formDefinition[key]);

// The Action uses its own M2M identity. No Worker credentials are rotated or reused.
const clientName = 'eastmoney signup profile';
const clients = management('get', 'clients?fields=client_id,name,app_type&include_fields=true');
const matches = clients.filter((item) => item.name === clientName);
if (matches.length > 1) throw new Error('Ambiguous signup profile management application');
const manager = matches.length ? management('get', `clients/${matches[0].client_id}`)
  : management('post', 'clients', { name: clientName, app_type: 'non_interactive', grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_post' });
if (manager.app_type !== 'non_interactive' || !manager.client_secret) throw new Error('Unexpected signup profile management application');
const audience = `https://${AUTH0_DOMAIN}/api/v2/`;
const grants = management('get', `client-grants?client_id=${manager.client_id}`);
const grant = grants.find((item) => item.audience === audience);
if (grant && JSON.stringify(grant.scope) !== JSON.stringify(['update:users'])) throw new Error('Review the management application grant before modifying it');
if (!grant) management('post', 'client-grants', { client_id: manager.client_id, audience, scope: ['update:users'] });
const tokenResponse = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'client_credentials', client_id: manager.client_id, client_secret: manager.client_secret, audience }),
});
if (!tokenResponse.ok) throw new Error('Signup profile management credentials could not be verified');
await tokenResponse.body?.cancel();
const actions = management('get', 'actions/actions?per_page=100').actions;
let profile = actions.find((item) => item.name === clientName);
if (profile) {
  profile = management('get', `actions/actions/${profile.id}`);
  if (profile.code !== profile.deployed_version?.code && profile.code !== profileCode) throw new Error('Preserve the unrelated signup profile Action draft');
} else profile = management('post', 'actions/actions', { name: clientName, runtime: 'node22',
  supported_triggers: [{ id: 'post-login', version: 'v3' }], code: profileCode });
if ((profile.secrets ?? []).some((item) => !['EASTMONEY_CLIENT_ID', 'PROFILE_CLIENT_ID', 'PROFILE_CLIENT_SECRET', 'PROFILE_FORM_ID'].includes(item.name))) throw new Error('Review unrelated Action secrets before updating');
management('patch', `actions/actions/${profile.id}`, { code: profileCode, secrets: [
  { name: 'EASTMONEY_CLIENT_ID', value: clientId }, { name: 'PROFILE_FORM_ID', value: form.id }, { name: 'PROFILE_CLIENT_ID', value: manager.client_id }, { name: 'PROFILE_CLIENT_SECRET', value: manager.client_secret }] });
management('post', `actions/actions/${profile.id}/deploy`);
assert.deepEqual(management('get', bindingsPath).bindings.map((item) => [item.action.id, item.display_name]),
  previousBindings.map((item) => [item.action.id, item.display_name]), 'Login bindings changed during preparation');
const bindings = [{ ref: { type: 'action_id', value: profile.id }, display_name: clientName },
  ...previousBindings.filter((item) => item.action.id !== profile.id).map((item) => ({ ref: { type: 'action_id', value: item.action.id }, display_name: item.display_name }))];
management('patch', bindingsPath, { bindings });
// Mark new signups as incomplete only after the required profile Form is bound.
management('patch', `actions/actions/${registrationId}`, { code: registrationCode });
management('post', `actions/actions/${registrationId}/deploy`);
assert.equal(management('get', `actions/actions/${registrationId}`).deployed_version.code, registrationCode);
assert.equal(management('get', `actions/actions/${profile.id}`).deployed_version.code, profileCode);
const active = management('get', bindingsPath).bindings;
assert.deepEqual(active.map((item) => item.action.id), bindings.map((item) => item.ref.value));
console.log(JSON.stringify({ verified: true, registrationAction: registrationId, profileAction: profile.id, formId: form.id, loginDomain: domain }));
