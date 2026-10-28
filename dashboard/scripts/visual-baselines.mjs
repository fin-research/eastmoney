import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readJson, walk } from './visual-coverage.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyCandidate(metadata, currentSha, directories, read) {
  if (metadata.sha !== currentSha) throw new Error(`Stale candidate: ${metadata.sha}; current HEAD: ${currentSha}. Regenerate after code changes.`);
  if (!metadata.files?.length) throw new Error('Empty candidate');
  if (new Set(metadata.files.map(file => file.path)).size !== metadata.files.length) throw new Error('Duplicate candidate path');
  for (const file of metadata.files) {
    if (!directories.some(dir => file.path.startsWith(`${dir}/`)) || !file.path.endsWith('.png') || file.path.split('/').some(part => part === '..' || part === '.') || file.path.includes('\\')) throw new Error(`Unexpected candidate path: ${file.path}`);
    if (hash(read(file.path)) !== file.sha256) throw new Error(`Candidate checksum mismatch: ${file.path}`);
  }
}
export function main(args) {
  const manifest = readJson('visual-coverage.json');
  if (args[0] === 'record') {
    const files = manifest.baselineDirectories.flatMap(directory => walk(directory)).filter(file => file.endsWith('.png')).sort()
      .map(file => ({ path: relative(process.cwd(), file).replaceAll('\\', '/'), sha256: hash(readFileSync(file)) }));
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/visual-baseline-candidate.json', JSON.stringify({ sha: git('rev-parse', 'HEAD'),
      ref: process.env.GITHUB_REF ?? git('branch', '--show-current'), runId: process.env.GITHUB_RUN_ID ?? null, files }, null, 2) + '\n');
    return;
  }
  if (args[0] !== 'import' || !args[1] || args[2] !== '--reviewed') throw new Error('Usage: node scripts/visual-baselines.mjs import <downloaded-artifact> --reviewed');
  if (git('status', '--porcelain')) throw new Error('Import requires a clean worktree. Keep downloaded artifacts outside the checkout.');
  const directory = args[1];
  const metadata = readJson(join(directory, 'test-results/visual-baseline-candidate.json'));
  verifyCandidate(metadata, git('rev-parse', 'HEAD'), manifest.baselineDirectories, path => readFileSync(join(directory, path)));
  for (const file of metadata.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    copyFileSync(join(directory, file.path), file.path);
  }
  console.log(`Imported ${metadata.files.length} reviewed candidates from ${metadata.sha}. Review git diff, commit, then require ordinary CI without updates.`);
}
if (process.argv[1]?.endsWith('/visual-baselines.mjs')) main(process.argv.slice(2));
