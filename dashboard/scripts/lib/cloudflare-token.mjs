import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Resolve the shared, untracked credential file from any Git worktree. */
export async function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  try {
    return parseEnv(await readFile(resolve(dirname(common), '.env'), 'utf8')).CLOUDFLARE_API_TOKEN;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
