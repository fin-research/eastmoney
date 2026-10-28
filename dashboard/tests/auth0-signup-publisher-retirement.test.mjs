import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/publish-auth0-signup.mjs', import.meta.url));

test('the retired signup publisher refuses before any Auth0 operation', () => {
  for (const args of [[], ['--apply']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /Signup profile Auth0 configuration is owned by Gateway/, JSON.stringify(args));
    assert.equal(result.stdout, '', JSON.stringify(args));
  }
});
