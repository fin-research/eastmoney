import { Buffer } from 'node:buffer';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';

it('encrypts the login password in workerd using DER without re-importing a PublicKeyObject', async () => {
  const worker = await unstable_dev('tests/fixtures/camel-crypto.ts', {
    config: 'tests/fixtures/wrangler.camel-crypto.jsonc', local: true, logLevel: 'none', compatibilityDate: '2026-08-29',
    compatibilityFlags: ['nodejs_compat'], experimental: { disableExperimentalWarning: true },
  });
  try {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const response = await worker.fetch('/', { method: 'POST', body: JSON.stringify({ password: 'runtime-password', key }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { encrypted: string };
    expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(body.encrypted, 'base64')).toString()).toBe('runtime-password');
  } finally { await worker.stop(); }
}, 30_000);
