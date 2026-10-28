import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = 'ghcr.io/hasbai/financial-visual-ci@sha256:7c8b030fa654dfd7acb74db9fbca0fe413ca81024536f6d361712d0920fd6444';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'visual-coverage.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root });
const paths = bytes => bytes.toString().split('\0').filter(Boolean);
const tracked = () => [...new Set(paths(git('ls-files', '-z', '--cached', '--others', '--exclude-standard')))]
  .filter(path => existsSync(join(root, path))).sort();
const digest = files => {
  const hash = createHash('sha256');
  for (const path of files) hash.update(path).update('\0').update(readFileSync(join(root, path)));
  return hash.digest('hex');
};
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  const path = join(dir, item.name);
  return item.isDirectory() ? walk(path) : [path];
});

const args = process.argv.slice(2);
const selected = new Set();
let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--page' && args[i + 1]) selected.add(args[++i]);
  else throw new Error('Unknown option: ' + args[i]);
}
if (!all && !selected.size) {
  const files = paths(git('diff', '--name-only', '-z', 'origin/main', '--'))
    .concat(paths(git('ls-files', '-z', '--others', '--exclude-standard')));
  const pages = new Set(manifest.pages.map(page => page.source));
  const unknown = files.filter(path => (path.startsWith('src/') || path.startsWith('tests/visual/') || path === 'visual-coverage.json') && !pages.has(path));
  if (unknown.length) throw new Error('Shared UI changes need explicit --page or --all:\n' + unknown.join('\n'));
  for (const path of files) if (pages.has(path)) selected.add(path);
  if (!selected.size) { console.log('No changed page with a visual scenario.'); process.exit(0); }
}

const files = tracked();
const pnpmStore = execFileSync('pnpm', ['store', 'path'], { cwd: root, encoding: 'utf8' }).trim();
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const proxyArgs = proxy && ['localhost', '127.0.0.1'].includes(proxy.hostname) && !proxy.username && !proxy.password
  ? (proxy.hostname = 'host.docker.internal', ['-e', 'HTTP_PROXY=' + proxy, '-e', 'HTTPS_PROXY=' + proxy,
    '-e', 'NO_PROXY=localhost,127.0.0.1,::1']) : [];
const stage = join(root, '.local-visual', 'linux-workspace');
mkdirSync(stage, { recursive: true });
const indexFile = join(stage, '.source-files.json');
const previous = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
for (const path of previous) if (!files.includes(path) && !path.split('/').includes('..')) rmSync(join(stage, path), { force: true });
for (const path of files) {
  mkdirSync(dirname(join(stage, path)), { recursive: true });
  cpSync(join(root, path), join(stage, path), { force: true, dereference: false });
}
writeFileSync(indexFile, JSON.stringify(files));
const before = new Set(existsSync(join(stage, '.local-visual')) ? readdirSync(join(stage, '.local-visual')) : []);
const innerArgs = all ? ['--all'] : [...selected].flatMap(page => ['--page', page]);
const command = 'pnpm install --frozen-lockfile --store-dir=/pnpm-store --prefer-offline && node scripts/local-visual.mjs "$@"';
const result = spawnSync('docker', [
  'run', '--rm', '--init', '--ipc=host', '--platform', 'linux/arm64',
  '-e', 'CI=true', '-e', 'GITHUB_ACTIONS=true',
  ...proxyArgs,
  '--mount', 'type=bind,source=' + stage + ',target=/work',
  '--mount', 'type=bind,source=' + dirname(pnpmStore) + ',target=/pnpm-store',
  '--workdir', '/work', image, 'sh', '-lc', command, 'visual-linux', ...innerArgs,
], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Pinned Linux visual run failed: ' + (result.status ?? result.error));

const outputRoot = join(stage, '.local-visual');
const runName = readdirSync(outputRoot).filter(name => !before.has(name)).sort().at(-1);
if (!runName) throw new Error('Linux run produced no review images');
const destination = join(root, '.local-visual', runName);
cpSync(join(outputRoot, runName), destination, { recursive: true });
const review = join(destination, 'review');
const screenshots = new Map();
for (const source of walk(review).filter(path => path.endsWith('.png'))) {
  const parts = relative(review, source).split(sep);
  if (parts.length !== 3) throw new Error('Unexpected review image: ' + source);
  const [, project, snapshot] = parts;
  const baseline = join('tests/visual/__screenshots__/linux-ci', project, snapshot).replaceAll(sep, '/');
  const hash = sha(source);
  if (screenshots.has(baseline) && screenshots.get(baseline).sha256 !== hash) throw new Error('Conflicting candidate: ' + baseline);
  screenshots.set(baseline, { baseline, review: relative(destination, source).replaceAll(sep, '/'), sha256: hash });
}
if (!screenshots.size) throw new Error('Linux run produced no PNG candidates');
writeFileSync(join(destination, 'candidate.json'), JSON.stringify({
  image, sourceDigest: digest(files), screenshots: [...screenshots.values()],
}, null, 2) + '\n');
console.log('Review ' + screenshots.size + ' Linux screenshots in ' + review);
console.log('After review: pnpm visual:baseline:import-local ' + destination + ' --reviewed');
