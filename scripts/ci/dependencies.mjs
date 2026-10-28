import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const workspace = parse(read('pnpm-workspace.yaml'));
const lock = parse(read('pnpm-lock.yaml'));
const projects = ['gateway', 'dashboard', 'data', 'messenger', 'ingest', 'quant/online'];
assert.deepEqual(workspace.packages, projects);
assert.equal(JSON.parse(read('package.json')).packageManager, 'pnpm@10.33.2');
assert.deepEqual(Object.keys(lock.importers).sort(), ['.', ...projects].sort());
for (const [name, version] of Object.entries(workspace.catalog)) {
  assert.match(version, /^(\d+\.\d+\.\d+(?:-[\w.-]+)?|https:\/\/[^\s]+\.tgz)$/, `${name} must have an exact version`);
}
for (const project of ['.', ...projects]) {
  const pkg = JSON.parse(read(project + '/package.json'));
  if (project !== '.') {
    assert.equal(pkg.packageManager, undefined, `${project}: root owns packageManager`);
    for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      assert.equal(existsSync(new URL('../../' + project + '/' + name, import.meta.url)), false, `${project}: nested ${name}`);
    }
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
      assert.equal(specifier, 'catalog:', `${project}: ${name} must use catalog`);
      const expected = workspace.catalog[name];
      assert.ok(expected, `${name}: missing catalog entry`);
      assert.equal(lock.importers[project][section][name].specifier, 'catalog:');
      assert.equal(lock.catalogs.default[name].specifier, expected);
      assert.equal(lock.importers[project][section][name].version.split('(')[0], expected);
    }
  }
}
assert.ok(workspace.onlyBuiltDependencies.includes('better-sqlite3'));
assert.equal(workspace.allowBuilds, undefined);
console.log('Six JavaScript projects share exact catalog versions and one lockfile.');
