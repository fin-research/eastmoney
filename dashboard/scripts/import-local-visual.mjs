import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = resolve(process.argv[2] ?? '');
if (process.argv[3] !== '--reviewed' || !directory.startsWith(join(root, '.local-visual') + '/')) {
  throw new Error('Usage: pnpm visual:baseline:import-local <local-run-directory> --reviewed');
}
const metadata = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'));
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
  .toString().split('\0').filter(path => path && existsSync(join(root, path))))].sort();
const digest = createHash('sha256');
for (const path of files) digest.update(path).update('\0').update(readFileSync(join(root, path)));
if (digest.digest('hex') !== metadata.sourceDigest) throw new Error('Source changed after capture; regenerate screenshots');
if (!metadata.screenshots?.length) throw new Error('No screenshots to import');
for (const entry of metadata.screenshots) {
  if (isAbsolute(entry.baseline) || !entry.baseline.startsWith('tests/visual/__screenshots__/linux-ci/')
    || entry.baseline.split('/').includes('..') || entry.review.split('/').includes('..')) throw new Error('Invalid candidate path');
  const source = join(directory, entry.review);
  if (!entry.review.startsWith('review/') || createHash('sha256').update(readFileSync(source)).digest('hex') !== entry.sha256) {
    throw new Error('Candidate checksum mismatch: ' + entry.review);
  }
  mkdirSync(dirname(join(root, entry.baseline)), { recursive: true });
  copyFileSync(source, join(root, entry.baseline));
}
console.log('Imported ' + metadata.screenshots.length + ' reviewed Linux baselines. Inspect git diff before committing.');
