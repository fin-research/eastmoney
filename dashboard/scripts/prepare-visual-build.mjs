// Replace all harness CSS with the unmodified stylesheets emitted by SvelteKit.
// Route-node stylesheet order is preserved; no CSS is re-minified or concatenated.
import { cp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';

const nodeDirectory = '.svelte-kit/generated/client-optimized/nodes';
const routes = new Map();
const clientRoutes = new Map();
const clientManifest = JSON.parse(await readFile('.svelte-kit/output/client/.vite/manifest.json', 'utf8'));
for (const name of await readdir(nodeDirectory)) {
  if (!name.endsWith('.js')) continue;
  const entry = await readFile(join(nodeDirectory, name), 'utf8');
  const component = entry.match(/export\s*\{\s*default as component\s*\}\s*from\s*["']([^"']+)["']/)?.[1];
  if (!component) continue;
  const source = relative(process.cwd(), resolve(nodeDirectory, component)).replaceAll('\\', '/');
  const serverNode = await readFile(`.svelte-kit/output/server/nodes/${name}`, 'utf8');
  const styles = serverNode.match(/export const stylesheets = (\[[^;]*\]);/)?.[1];
  if (!styles) throw new Error(`Missing production stylesheet metadata: ${source}`);
  routes.set(source, JSON.parse(styles));
  clientRoutes.set(source, clientManifest[`${nodeDirectory}/${name}`]?.css ?? []);
}
function stylesFor(...sources) {
  return [...new Set(sources.flatMap(source => {
    if (!routes.has(source)) throw new Error(`Production route not built: ${source}`);
    return routes.get(source);
  }))];
}
const layout = 'src/routes/+layout.svelte';
const financing = 'src/routes/financing/+layout.svelte';
// Schedule is a component fixture: its ModuleCard wrapper is not on the SOP
// route itself. Include that component's shipping chunk, never harness CSS.
const moduleCardStyles = Object.values(clientManifest).filter(chunk => chunk.name === 'ModuleCard').flatMap(chunk => chunk.css ?? []);
if (!moduleCardStyles.length) throw new Error('Missing production ModuleCard CSS for the schedule fixture');
const map = {
  '/': stylesFor(layout, 'src/routes/+page.svelte'),
  // The login route is CSR-only: its CSS is on the client entry, not the SSR node.
  '/auth/login': [...new Set([...stylesFor(layout, 'src/routes/auth/login/+page.svelte'), ...clientRoutes.get('src/routes/auth/login/+page.svelte')])],
  '/auth/verify-email': stylesFor(layout, 'src/routes/auth/verify-email/+page.svelte'),
  '/trading-research': stylesFor(layout, 'src/routes/trading-research/+page.svelte', 'src/routes/trading-research/[view]/+page.svelte'),
  '/credit-workbench': stylesFor(layout, 'src/routes/credit-workbench/[[view]]/+page.svelte'),
  '/news': stylesFor(layout, 'src/routes/news/[id]/+page.svelte'),
  '/articles': stylesFor(layout, 'src/routes/articles/[id]/+page.svelte'),
  '/commentaries': stylesFor(layout, 'src/routes/commentaries/[id]/+page.svelte'),
  '/fund-report': stylesFor(layout, 'src/routes/fund-report/+page.svelte'),
  '/market-briefing': stylesFor(layout, 'src/routes/market-briefing/+page.svelte'),
  '/management/people': stylesFor(layout, 'src/routes/management/+layout.svelte', 'src/routes/management/people/+page.svelte'),
  '/management/me': stylesFor(layout, 'src/routes/management/+layout.svelte', 'src/routes/management/me/+page.svelte'),
  '/management/notifications': stylesFor(layout, 'src/routes/management/+layout.svelte', 'src/routes/management/notifications/+page.svelte'),
  '/management/messenger': stylesFor(layout, 'src/routes/management/+layout.svelte', 'src/routes/management/messenger/+page.svelte'),
  '/management/permissions': stylesFor(layout, 'src/routes/management/+layout.svelte', 'src/routes/management/permissions/+page.svelte'),
  '/financing': stylesFor(layout, financing, 'src/routes/financing/+page.svelte'),
  '/financing/projects/project-1': stylesFor(layout, financing, 'src/routes/financing/projects/[id]/+page.svelte'),
  '/financing/projects': stylesFor(layout, financing, 'src/routes/financing/projects/+page.svelte'),
  '/financing/liability-report': stylesFor(layout, financing, 'src/routes/financing/liability-report/+page.svelte'),
  '/financing/schedule': [...new Set([...stylesFor(layout, financing, 'src/routes/financing/sop/[id]/+page.svelte'), ...moduleCardStyles])],
  '/financing/sop/short-term': stylesFor(layout, financing, 'src/routes/financing/sop/[id]/+page.svelte'),
  '/financing/sop/reminders': stylesFor(layout, financing, 'src/routes/financing/sop/reminders/+page.svelte'),
  '/financing/sop': stylesFor(layout, financing, 'src/routes/financing/sop/+page.svelte'),
  '/financing/bond-investors': stylesFor(layout, financing, 'src/routes/financing/bond-investors/+page.svelte'),
  '/financing/debts': stylesFor(layout, financing, 'src/routes/financing/debts/[id]/+page.svelte'),
  '/financing/filters': stylesFor(layout, financing, 'src/routes/financing/+page.svelte'),
  '/financing/data': stylesFor(layout, financing, 'src/routes/financing/data/+page.svelte'),
  '/financing/clients': stylesFor(layout, financing, 'src/routes/financing/clients/+page.svelte'),
  '/ui-contracts': stylesFor(layout, financing, 'src/routes/financing/sop/[id]/+page.svelte', 'src/routes/financing/debts/[id]/+page.svelte'),
};
const files = [...new Set(Object.values(map).flat())];
if (!files.length || Object.values(map).some(styles => !styles.length)) throw new Error('Production stylesheets are empty');
await cp('.svelte-kit/output/client/_app', 'visual-dist/_app', { recursive: true });
// Match shipping static assets as well as route CSS; logos must not become broken-image placeholders.
await cp('static', 'visual-dist', { recursive: true });
const hashes = {};
for (const file of files) {
  const original = await readFile(`.svelte-kit/output/client/${file}`);
  const copied = await readFile(`visual-dist/${file}`);
  if (!original.equals(copied)) throw new Error(`Production CSS copy differs: ${file}`);
  hashes[file] = createHash('sha256').update(original).digest('hex');
}
// cssCodeSplit:false ensures JS cannot load a second, harness-generated stylesheet.
const html = await readFile('visual-dist/index.html', 'utf8');
await writeFile('visual-dist/index.html', html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, ''));
for (const file of await readdir('visual-dist/assets')) if (file.endsWith('.css')) await rm(`visual-dist/assets/${file}`);
await writeFile('visual-dist/production-styles.json', JSON.stringify(map, null, 2) + '\n');
await writeFile('visual-dist/production-css.json', JSON.stringify({ routes: map, sha256: hashes }, null, 2) + '\n');
console.log(`Prepared ${files.length} unchanged production stylesheets for ${Object.keys(map).length} harness routes.`);
