import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export function baselinePath(manifest, evidence, project, snapshot) {
  return manifest.baselineTemplate.replace('{project}', project)
    .replace('{spec}', evidence.spec.split('/').at(-1)).replace('{snapshot}', snapshot);
}

// Read the existing navigation registry without executing application code.
function registryIds(root, registry) {
  const file = ts.createSourceFile(registry.source, readFileSync(join(root, registry.source), 'utf8'), ts.ScriptTarget.Latest, true);
  let values;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === registry.export) {
      let value = node.initializer;
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
      if (!value || !ts.isArrayLiteralExpression(value)) throw new Error(`Registry is no longer an array: ${registry.source}`);
      values = value.elements.map(element => {
        const id = element.properties?.find(property => property.name?.getText(file).replaceAll(/["']/g, '') === 'id');
        if (!id || !ts.isStringLiteral(id.initializer)) throw new Error(`Registry id must be explicit: ${registry.source}`);
        return id.initializer.text;
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!values?.length) throw new Error(`Missing navigation registry: ${registry.export}`);
  return values;
}

export function validateManifest(manifest, root = process.cwd(), { allowMissingBaselines = false } = {}) {
  const errors = [];
  const actual = walk(join(root, manifest.inventory.root)).map(file => relative(root, file).replaceAll('\\', '/'))
    .filter(file => file.endsWith(manifest.inventory.suffix));
  const declared = manifest.pages.map(page => page.source);
  for (const file of actual) if (!declared.includes(file)) errors.push(`Unlisted page: ${file}`);
  for (const file of declared) if (!actual.includes(file)) errors.push(`Stale page: ${file}`);
  if (new Set(declared).size !== declared.length) errors.push('Duplicate page entries');
  const ids = manifest.scenarios.map(scene => scene.id);
  if (new Set(ids).size !== ids.length) errors.push('Duplicate scenario ids');
  for (const page of manifest.pages) {
    if (!page.scenarios?.length && !page.exemption?.trim()) errors.push(`Page needs evidence or an explicit exemption: ${page.source}`);
    for (const id of page.scenarios ?? []) if (!ids.includes(id)) errors.push(`Unknown scenario ${id}: ${page.source}`);
  }
  // Financial has a small conditional router rather than a route registry.
  // Track its literal dispatch branches as well as page modules, so a new URL
  // reusing an existing component cannot silently bypass the inventory.
  if (manifest.router) {
    const text = readFileSync(join(root, manifest.router.source), 'utf8');
    const paths = new Set([...text.matchAll(/\bpath\s*(?:===\s*|\.startsWith\(\s*)["']([^"']+)["']/g)].map(match => match[1]));
    if (!paths.size) errors.push('Router dispatch syntax changed; update route discovery');
    for (const path of paths) if (!manifest.router.paths[path]?.length) errors.push(`Unlisted router path: ${path}`);
    for (const [path, scenarios] of Object.entries(manifest.router.paths)) {
      if (!paths.has(path)) errors.push(`Stale router path: ${path}`);
      for (const id of scenarios) if (!ids.includes(id)) errors.push(`Unknown router scenario: ${id}`);
    }
  }
  for (const registry of manifest.registries ?? []) {
    const actualIds = registryIds(root, registry);
    for (const id of actualIds) if (!registry.scenarios[id]) errors.push(`Unlisted view: ${registry.export}.${id}`);
    for (const [id, scenario] of Object.entries(registry.scenarios)) {
      if (!actualIds.includes(id)) errors.push(`Stale view: ${registry.export}.${id}`);
      if (!ids.includes(scenario)) errors.push(`Unknown view scenario: ${scenario}`);
    }
  }
  for (const scene of manifest.scenarios) {
    if (scene.kind === 'deferred') {
      if (!scene.reason?.trim()) errors.push(`Missing exemption reason: ${scene.id}`);
      continue;
    }
    if (!['screenshot', 'interaction'].includes(scene.kind) || !scene.evidence?.length) {
      errors.push(`Missing evidence: ${scene.id}`); continue;
    }
    for (const evidence of scene.evidence) {
      if (!existsSync(join(root, evidence.spec))) errors.push(`Missing spec: ${evidence.spec}`);
      if (!evidence.test || !evidence.projects?.length) errors.push(`Missing test/project: ${scene.id}`);
      if (scene.kind === 'screenshot') {
        if (!evidence.snapshots?.length) errors.push(`Missing screenshot names: ${scene.id}`);
        for (const project of evidence.projects) for (const snapshot of evidence.snapshots ?? []) {
          const path = baselinePath(manifest, evidence, project, snapshot);
          if (!allowMissingBaselines && !existsSync(join(root, path))) errors.push(`Missing CI baseline: ${path}`);
        }
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { pages: actual.length, screenshot: manifest.scenarios.filter(s => s.kind === 'screenshot').length,
    interaction: manifest.scenarios.filter(s => s.kind === 'interaction').length,
    deferred: manifest.scenarios.filter(s => s.kind === 'deferred').length,
    exemptPages: manifest.pages.filter(p => p.exemption).length };
}

function screenshotStep(steps, snapshot) {
  return steps.some(step => (!step.error && step.category === 'expect' && step.title.includes(`toHaveScreenshot(${snapshot})`)) || screenshotStep(step.steps ?? [], snapshot));
}
export function validateExecution(manifest, records) {
  const errors = [];
  for (const scene of manifest.scenarios.filter(s => s.kind !== 'deferred')) {
    for (const evidence of scene.evidence) for (const project of evidence.projects) {
      const record = records.find(item => item.spec === evidence.spec && item.title === evidence.test && item.project === project);
      if (!record || record.status !== 'passed') errors.push(`Coverage did not pass: ${scene.id} / ${project} / ${evidence.test}`);
      else if (scene.kind === 'screenshot') for (const snapshot of evidence.snapshots) {
        if (!screenshotStep(record.steps, snapshot)) errors.push(`No successful screenshot assertion: ${scene.id} / ${project} / ${snapshot}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
