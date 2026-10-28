import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
test('Maia is the only UI framework and preserves the brand palette', async () => {
  const [pkg, config, css] = await Promise.all(['package.json','components.json','src/app.css'].map(file=>readFile(new URL(file,root),'utf8')));
  assert.equal(JSON.parse(config).style, 'maia');
  assert.equal(JSON.parse(config).iconLibrary, 'lucide');
  assert.doesNotMatch(pkg + css, /daisyui/i);
  for (const name of ['bits-ui','svelte-sonner','tailwind-variants','tailwind-merge','clsx','@lucide/svelte']) assert.ok(JSON.parse(pkg).dependencies[name]);
  assert.match(css, /--primary:\s*#2f6fd6/);
  for (const file of (await readdir(new URL('src/',root),{recursive:true})).filter(file=>/\.(svelte|css)$/.test(file))) {
    const source=await readFile(new URL('src/'+file,root),'utf8');
    assert.doesNotMatch(source, /@plugin\s+["']daisyui|\bclass=["'][^"']*\bbtn(?:\s|["'])/, file);
    assert.doesNotMatch(source, /export let |from ["']svelte\/legacy["']/, file);
  }
});

test('role drafts, personal entry and financing multi-select retain behavior', async () => {
  const {stdout} = await promisify(execFile)(process.execPath, ['--conditions=browser','tests/helpers/management-ui.mjs'], { cwd: root, timeout:60000 });
  assert.match(stdout, /Management and account interaction checks passed/);
});
