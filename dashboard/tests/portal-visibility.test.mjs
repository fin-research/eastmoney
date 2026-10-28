import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('portal renders only authorized cards from its first render', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--conditions=browser', 'tests/helpers/portal-visibility.mjs'],
    { cwd: new URL('../', import.meta.url), timeout: 60_000 });
  assert.match(stdout, /Portal visibility checks passed/);
});
