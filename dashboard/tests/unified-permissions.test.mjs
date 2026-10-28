import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PERMISSION_CODES, hasPermission } from '../src/lib/permissions.ts';
import { ROUTE_PERMISSIONS } from '../src/lib/route-permissions.ts';

const request = (path, method = 'GET', headers = {}) => new Request('https://eastmoney.hasbai.xyz' + path, { method, headers: { Origin: 'https://eastmoney.hasbai.xyz', ...headers } });

test('every application route and named mutation is registered in the one permission catalogue', async () => {
  const root = new URL('../src/routes/', import.meta.url);
  const files = await readdir(root, { recursive: true });
  for (const path of files.filter(path => /\+(page\.server|server)\.ts$/.test(path) || /\+page\.svelte$/.test(path))) {
    const id = '/' + path.split('/').slice(0, -1).join('/');
    // This handler is reachable only through GatewayDashboard; the public
    // Gateway endpoint owns its login policy and retires /api/mcp.
    if (id === '/api/mcp') {
      assert.equal(ROUTE_PERMISSIONS[id], undefined);
      assert.deepEqual(ROUTE_PERMISSIONS['/mcp'], { GET: 'login', POST: 'login', DELETE: 'login' });
      continue;
    }
    assert.ok(ROUTE_PERMISSIONS[id], `Missing route: ${id}`);
    const source = await readFile(new URL(path, root), 'utf8');
    if (path.endsWith('+server.ts')) for (const method of ['GET','POST','PUT','PATCH','DELETE']) {
      if (new RegExp(`export (?:const|(?:async )?function) ${method}\\b`).test(source)) assert.ok(ROUTE_PERMISSIONS[id][method], `${id}:${method}`);
    }
    const actions = source.split(/export const actions[^=]*=/)[1];
    if (actions) for (const [,name] of actions.matchAll(/(?:^|\n)\s*([A-Za-z][A-Za-z0-9]*): async \(/g)) assert.ok(ROUTE_PERMISSIONS[id][`POST:${name}`], `${id}:${name}`);
  }
  for (const methods of Object.values(ROUTE_PERMISSIONS)) for (const code of Object.values(methods)) assert.ok(['public','login','admin'].includes(code) || PERMISSION_CODES.includes(code), code);
  assert.equal(new Set(PERMISSION_CODES).size, PERMISSION_CODES.length);
  assert.ok(PERMISSION_CODES.every(code => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(code)));
});

test('client permission files retain the Gateway-generated contract fingerprint', async () => {
  const { createHash } = await import('node:crypto');
  const manifest = JSON.parse(await readFile(new URL('../src/lib/gateway-contracts.json', import.meta.url), 'utf8'));
  assert.equal(manifest.owner, 'eastmoney-gateway');
  for (const [file, hash] of Object.entries(manifest.files)) {
    const source = await readFile(new URL('../src/lib/' + file, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, 'Sync the Gateway contract instead of editing ' + file);
  }
});
