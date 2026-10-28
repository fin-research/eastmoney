import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH0_DOMAIN, management } from './lib/auth0-management.mjs';

const apply = process.argv.includes('--apply');
const textOnly = process.argv.includes('--text-only');
const theme = JSON.parse(await readFile(new URL('../auth0/branding/theme.json', import.meta.url), 'utf8'));
const text = JSON.parse(await readFile(new URL('../auth0/branding/zh-CN.json', import.meta.url), 'utf8'));
const prompts = management('get', 'prompts');
if (prompts.universal_login_experience !== 'new') throw new Error('Expected the existing New Universal Login experience');
const settings = management('get', 'tenants/settings');
const branding = management('get', 'branding');
let previousTheme = null;
try { previousTheme = management('get', 'branding/themes/default'); }
catch (error) { if (error.status !== 404) throw error; }
const previousText = Object.fromEntries(Object.keys(text).map((prompt) => [prompt, management('get', `prompts/${prompt}/custom-text/zh-CN`)]));
const desiredBranding = { ...branding, favicon_url: 'https://eastmoney.hasbai.xyz/favicon.svg',
  colors: { ...branding.colors, primary: theme.colors.primary_button, page_background: theme.page_background.background_color } };
const desiredTheme = { ...previousTheme, ...theme };
for (const section of ['colors', 'fonts', 'borders', 'widget', 'page_background']) {
  desiredTheme[section] = { ...previousTheme?.[section], ...theme[section] };
}
delete desiredTheme.themeId;
// The project requests Chinese pages. A single supported locale also prevents
// an English browser preference from overriding the default Chinese experience.
const desiredSettings = { enabled_locales: ['zh-CN'] };
console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', tenant: AUTH0_DOMAIN,
  textOnly,
  primary: theme.colors.primary_button, background: theme.page_background.background_color,
  locales: desiredSettings.enabled_locales, prompts: Object.keys(text), signupFields: 'separate custom-domain configuration' }));
if (!apply) process.exit(0);
const backupDirectory = await mkdtemp(join(tmpdir(), 'eastmoney-auth0-branding-'));
await writeFile(join(backupDirectory, 'before.json'), JSON.stringify({ branding, theme: previousTheme,
  settings: { enabled_locales: settings.enabled_locales }, text: previousText }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ backupDirectory }));
if (!textOnly) {
  management('patch', 'branding', desiredBranding);
  if (previousTheme?.themeId) management('patch', `branding/themes/${previousTheme.themeId}`, desiredTheme);
  else management('post', 'branding/themes', desiredTheme);
}
for (const [prompt, screens] of Object.entries(text)) {
  const merged = { ...previousText[prompt] };
  for (const [screen, values] of Object.entries(screens)) merged[screen] = { ...merged[screen], ...values };
  management('put', `prompts/${prompt}/custom-text/zh-CN`, merged);
  assert.deepEqual(management('get', `prompts/${prompt}/custom-text/zh-CN`), merged);
}
if (textOnly) {
  console.log(JSON.stringify({ verified: true, textOnly: true, prompts: Object.keys(text) }));
  process.exit(0);
}
management('patch', 'tenants/settings', desiredSettings);
const current = management('get', 'branding/themes/default');
for (const [section, value] of Object.entries(desiredTheme)) {
  if (value && typeof value === 'object') {
    for (const [key, expected] of Object.entries(value)) assert.deepEqual(current[section][key], expected);
  } else assert.deepEqual(current[section], value);
}
assert.deepEqual(management('get', 'tenants/settings').enabled_locales, desiredSettings.enabled_locales);
const currentBranding = management('get', 'branding');
assert.equal(currentBranding.colors.primary, desiredBranding.colors.primary);
assert.equal(currentBranding.colors.page_background, desiredBranding.colors.page_background);
console.log(JSON.stringify({ verified: true, themeId: current.themeId, locales: desiredSettings.enabled_locales }));
