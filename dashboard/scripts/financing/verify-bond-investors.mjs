import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SITE_ORIGIN, createHttpSession, loginTestAccount, readAuthTestConfig } from '../lib/programmatic-login.mjs';

const args = process.argv.slice(2);
if (!args.includes('--expected')) throw new Error('用法：node --use-env-proxy scripts/financing/verify-bond-investors.mjs --expected <导入核对.json> [--output <线上核对.json>]');
const expected = JSON.parse(fs.readFileSync(args[args.indexOf('--expected') + 1], 'utf8'));
const requireKit = createRequire(import.meta.resolve('@sveltejs/kit/package.json'));
const { unflatten } = await import(requireKit.resolve('devalue'));
const path = `/financing/bond-investors?date=${expected.reportDate}`;
const anonymous = await createHttpSession().request(SITE_ORIGIN + path, { followRedirects: false });
assert.ok([401, 303].includes(anonymous.status), `匿名响应 ${anonymous.status}`);
const session = await loginTestAccount(await readAuthTestConfig());
const html = await session.request(SITE_ORIGIN + path, { followRedirects: false });
assert.equal(html.status, 200, `页面响应 ${html.status}`);
assert.match(html.headers.get('cache-control'), /no-store/);
for (const id of ['investor-total', 'investor-outstanding', 'investor-total-distribution', 'investor-outstanding-distribution', 'investor-ranking']) assert.ok(html.text.includes(`id="${id}"`), `缺少模块 ${id}`);
const response = await session.request(SITE_ORIGIN + `/financing/bond-investors/__data.json?date=${expected.reportDate}`, { followRedirects: false, headers: { Accept: 'application/json' } });
assert.equal(response.status, 200);
const envelope = JSON.parse(response.text);
const actual = envelope.nodes.filter(node => node?.type === 'data').map(node => unflatten(node.data)).find(node => node?.report)?.report;
assert.ok(actual, '缺少线上报表数据');
let checked = 0;
function compare(left, right, key = 'report') {
  if (typeof right === 'number') { assert.ok(typeof left === 'number' && Math.abs(left - right) < 1e-8, `${key} 数值不一致`); checked++; }
  else if (right && typeof right === 'object') { assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), `${key} 字段不一致`); for (const field of Object.keys(right)) compare(left[field], right[field], `${key}.${field}`); }
  else assert.equal(left, right, `${key} 不一致`);
}
compare(actual, expected.report);
const invalid = await session.request(SITE_ORIGIN + '/financing/bond-investors?date=2026-02-30', { followRedirects: false });
assert.equal(invalid.status, 400);
const result = { online: true, browserUsed: false, reportDate: expected.reportDate, sourceSha256: expected.sourceSha256, anonymousStatus: anonymous.status, pageStatus: html.status, dataStatus: response.status, invalidDateStatus: invalid.status, numericChecks: checked, totalYi: actual.total.total, outstandingYi: actual.outstanding.total, investors: actual.investors.length, coveredBonds: actual.coverage.coveredBonds };
if (args.includes('--output')) fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
