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
