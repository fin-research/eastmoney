import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('共享header提供层级链接，只有多面页面显示标签栏', async () => {
  await promisify(execFile)(process.execPath, ['--conditions=browser', 'tests/helpers/page-header.mjs'], {
    cwd: new URL('../', import.meta.url), timeout: 30_000, maxBuffer: 20_000,
  });
});
