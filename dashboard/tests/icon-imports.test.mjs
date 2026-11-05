import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : /\.(svelte|ts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

test('icons are imported per file, never through the @lucide/svelte barrel', () => {
  const root = new URL('../src', import.meta.url).pathname;
  const offenders = sources(root).filter((file) => /(?:from|import)\s*\(?\s*['"`]@lucide\/svelte['"`]/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], 'the barrel makes vite load ~7800 icon files at once and exhausts file handles on the cloud builder (EMFILE)');
});
