import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readDeploymentStatus } from './lib/worker-deployment.mjs';
import { cloudflareToken } from './lib/cloudflare-token.mjs';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const args = process.argv.slice(2).filter(v => v !== '--');
const commitArg = args.find(v => v.startsWith('--commit='));
const waitArg = args.find(v => v.startsWith('--wait='));
if (args.some(v => !v.startsWith('--commit=') && !v.startsWith('--wait='))) throw new Error('Use --commit=<SHA> and --wait=<seconds>.');
const commit = commitArg?.slice(9) ?? execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const wait = Number(waitArg?.slice(7) ?? 0);
if (!/^[a-f0-9]{40}$/.test(commit) || !Number.isFinite(wait) || wait < 0 || wait > 1800) throw new Error('Invalid commit or wait (0–1800 seconds).');
const deadline = Date.now() + wait * 1000;
let status;
do {
  status = await readDeploymentStatus({ account: config.vars.CLOUDFLARE_ACCOUNT_ID, worker: config.name,
    commit, token: await cloudflareToken() });
  console.log(JSON.stringify(status));
  if (status.state === 'deployed' || status.state === 'failed' || Date.now() >= deadline) break;
  await new Promise(r => setTimeout(r, Math.min(20_000, deadline - Date.now())));
} while (Date.now() < deadline);
process.exitCode = status.state === 'deployed' ? 0 : status.state === 'pending' ? 2 : status.state === 'failed' ? 3 : 4;
