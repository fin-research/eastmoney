import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardRequiresLogin, requireSameOrigin, safeReturnTo } from '../src/lib/server/dashboard-access.ts';
import { gatewayContext } from '../src/lib/server/gateway-context.ts';
import { publicMarketRequest } from '../src/lib/server/public-market-resources.ts';

const request = (path, method = 'GET', headers = {}) => new Request(`https://eastmoney.hasbai.xyz${path}`, { method, headers });

test('portal, market reports and authentication bootstrap stay public; internal business and writes require login', () => {
  for (const path of ['/', '/market-briefing', '/market-briefing/text', '/auth/login', '/auth/callback', '/auth/logout', '/financing/login', '/auth/verify-email']) assert.equal(dashboardRequiresLogin(request(path)), false, path);
  for (const path of ['/market-briefing/unknown', '/market-hotspots', '/fund-report', '/api/rag/hotspots', '/api/market-report', '/trading-research', '/trading-research/credit', '/credit-workbench', '/credit-workbench/calendar', '/credit-workbench/weekly', '/credit-workbench/assistant', '/credit%2dworkbench/__data.json', '/trading%2dresearch/__data.json', '/api/credit', '/api/economic-indicators', '/api/credit-assistant/session', '/credit-assistant']) assert.equal(dashboardRequiresLogin(request(path)), true, path);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(dashboardRequiresLogin(request('/api/market-report', method)), true);
  assert.equal(dashboardRequiresLogin(request('/api/market-briefing', 'POST')), true);
});

test('a forwarded email is not identity, and unsafe requests require the actual site origin', async () => {
  const env = { ACCESS_MODE: 'enforce', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'site' };
  assert.throws(() => gatewayContext(env), { status: 503 });
  assert.equal(gatewayContext({ GATEWAY_CONTEXT: { user: null } }).user, null);
  assert.throws(() => requireSameOrigin(request('/api/market-report', 'PUT', { Origin: 'https://other.test' })), { status: 403 });
  assert.doesNotThrow(() => requireSameOrigin(request('/api/market-report', 'PUT', { Origin: 'https://eastmoney.hasbai.xyz' })));
});

test('return paths cannot become external redirects or login loops', () => {
  for (const path of ['https://other.test', '//other.test', '/%5Cother.test', '/%2fother.test', '/auth/login', '/cdn-cgi/access/logout', '/%ZZ']) assert.equal(safeReturnTo(path), '/');
  assert.equal(safeReturnTo('/trading-research/credit?date=2026-09-07'), '/trading-research/credit?date=2026-09-07');
});

test('the public report channel cannot call arbitrary data endpoints or widen returned fields', () => {
  const good = publicMarketRequest('cfets', new URLSearchParams({ date: '2026-09-07', source: 'DR' }));
  assert.equal(new URL(good.url).pathname, '/data/cfets');
  assert.equal(new URL(good.url).searchParams.get('fields'), 'bondCode,weightedYield,weightedYieldUpDownValueBp');
  for (const resource of ['graphql', 'choice/css', 'news', 'constructor', '../choice/css']) assert.throws(() => publicMarketRequest(resource, new URLSearchParams()));
  assert.throws(() => publicMarketRequest('cfets', new URLSearchParams({ fields: 'password' })));
  assert.throws(() => publicMarketRequest('favorite-quotes', new URLSearchParams({ limit: '99999' })));
  assert.throws(() => publicMarketRequest('omo', new URLSearchParams({ startDate: '2000-01-01', endDate: '2026-09-07' })));
  assert.throws(() => publicMarketRequest('cfets', new URLSearchParams('source=DR&source=DIBO')));
});
