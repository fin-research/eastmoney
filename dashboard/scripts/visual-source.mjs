import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The capture and import bind both Dashboard source and its shared dependency graph.
export function visualSourceFiles(root) {
  const source = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString().split('\0').filter(Boolean);
  const dependencies = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
    'gateway/package.json', 'data/package.json', 'messenger/package.json', 'ingest/package.json', 'quant/online/package.json']
    .map(path => '../' + path);
  return [...new Set([...source, ...dependencies])].filter(path => existsSync(join(root, path))).sort();
}
