import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('root mounts one Sonner surface with deduplication, dismissal and paused lifetime', async () => {
  const layout=await readFile(new URL('../src/routes/+layout.svelte',import.meta.url),'utf8');
  assert.equal((layout.match(/<GlobalMessages\s*\/>/g)??[]).length,1);
  const {stdout}=await promisify(execFile)(process.execPath,['--conditions=browser','--conditions=svelte','tests/helpers/sonner-messages.mjs'],{cwd:new URL('../',import.meta.url),timeout:60000});
  assert.match(stdout,/Sonner notifications replace by key/);
});

test('二级池回退提示发布到全局消息而非上传状态栏', async () => {
  const page=await readFile(new URL('../src/lib/pages/BondLedgerPage.svelte',import.meta.url),'utf8');
  assert.match(page,/globalMessages\.warning\([\s\S]*所选范围无线上台账，已回退至/);
  assert.doesNotMatch(page,/uploadMessage\s*=\s*`所选范围无线上台账，已回退至/);
});
