import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { readDeploymentStatus } from './lib/worker-deployment.mjs';
import { cloudflareToken } from './lib/cloudflare-token.mjs';

const args = process.argv.slice(2).filter(v => v !== '--');
const reason = args.find(v => v.startsWith('--reason='))?.slice(9).trim();
if (args.some(v => !v.startsWith('--reason='))) throw new Error('Use --reason=<confirmed build failure>.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
git('fetch', 'origin', 'main');
const commit = git('rev-parse', 'HEAD');
const token = await cloudflareToken();
const inspect = () => readDeploymentStatus({ account: config.vars.CLOUDFLARE_ACCOUNT_ID, worker: config.name,
  commit, token });
function decision(status) {
  console.log(JSON.stringify(status));
  if (status.state === 'deployed') return false;
  if (status.state !== 'failed' || !reason) throw new Error('Manual deploy stopped. Wait for Cloudflare Builds; only a confirmed failure with --reason can use this fallback.');
  if (git('rev-parse', 'HEAD') !== commit || git('rev-parse', 'origin/main') !== commit || git('status', '--porcelain')) throw new Error('Manual fallback requires a clean checkout at current origin/main. Preserve unrelated work in its existing checkout.');
  const checks = JSON.parse(execFileSync('gh', ['api', `repos/fin-research/eastmoney/commits/${commit}/check-runs`], { encoding: 'utf8' }));
  if (!checks.check_runs.some(c => c.name === 'Monorepo CI' && c.app?.slug === 'github-actions' && c.status === 'completed' && c.conclusion === 'success')) throw new Error('Monorepo CI success on the target main commit is required. If merge queue used a different SHA, dispatch Eastmoney CI on current main and wait for success before this fallback.');
  return true;
}
if (decision(await inspect())) {
  const build = spawnSync('pnpm', ['build'], { stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Build failed; nothing deployed.');
  git('fetch', 'origin', 'main');
  if (decision(await inspect())) {
    const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--tag', `git:${commit}`], {
      stdio: 'inherit', env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    });
    if (result.status !== 0) throw new Error('Manual deploy failed.');
    const status = await inspect();
    if (status.state !== 'deployed') throw new Error('Deploy returned success but active traffic does not match the target commit.');
    console.log(JSON.stringify(status));
  }
}
