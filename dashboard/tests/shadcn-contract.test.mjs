import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
test('role drafts, personal entry and financing multi-select retain behavior', async () => {
  const {stdout} = await promisify(execFile)(process.execPath, ['--conditions=browser','tests/helpers/management-ui.mjs'], { cwd: root, timeout:60000 });
  assert.match(stdout, /Management and account interaction checks passed/);
});
