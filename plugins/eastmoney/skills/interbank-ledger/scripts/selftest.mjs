#!/usr/bin/env node
// 离线自测：node scripts/selftest.mjs。不联网、不登录、不写归档目录。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip.mjs';
import { shiftDecimal, pdfName, sourceRows, correctedRecords, REQUIRED } from './model.mjs';
import { prepareArchive, saveArchive } from './prepare.mjs';
import { Camel } from './camel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const XLSX = createRequire(import.meta.url)(path.join(here, 'vendor', 'xlsx.mini.cjs'));

function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
/** entries: [name, Buffer, {gbk?: Buffer, deflate?: boolean}] */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data, opt = {}] of entries) {
    const nameBytes = opt.gbk ?? Buffer.from(name), flags = opt.gbk ? 0 : 0x800, method = opt.deflate ? 8 : 0;
    const body = opt.deflate ? deflateRawSync(data) : data;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(flags, 6); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, body); central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const serial = 'IBO20261016000001', serial2 = 'IBO20261016000002';
const row = (id, amount = '10000') => ({ 成交编号: id, 成交日期: '2026-10-16', 本方方向: '拆入', 本方: '东方财富证券股份有限公司', 对手方: '上海农村商业银行股份有限公司', 本方资金账号: '000123', 对手方资金账号: '0004', '拆借金额(万)': amount, '拆借利率(%)': '1.27', 实际占款天数: '7', '拆借期限(天)': '7', 拆借利息: '2428.01', 到期还款金额: '100002428.01', 首次结算日: '2026-10-16', 到期还款日: '2026-10-23' });
function xlsx(rows) {
  const sheet = XLSX.utils.aoa_to_sheet([REQUIRED, ...rows.map(r => REQUIRED.map(h => r[h]))]);
  for (const key of Object.keys(sheet)) if (key.startsWith('A') === false && sheet[key]?.v === '000123') sheet[key].t = 's';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '信用拆借成交');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}
const pdf = id => Buffer.from(`%PDF-test ${id}`);
const pdfText = bytes => `${bytes.toString().match(/IBO\d{14}/)?.[0]}\n上海农村商业银行股份有限公司`;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('shiftDecimal keeps exact decimals', () => {
  assert.equal(shiftDecimal('1.27', -2), '0.0127');
  assert.equal(shiftDecimal('10000', -4), '1');
  assert.equal(shiftDecimal('50000.5', -4), '5.00005');
  assert.equal(shiftDecimal('1,000', 2), '100000');
  assert.throws(() => shiftDecimal('0', -2));
});
test('zip reads stored, deflated and GBK names', () => {
  const gbk = Buffer.from([0xd0, 0xc5, 0xd3, 0xc3, 0x2e, 0x78, 0x6c, 0x73, 0x78]); // 信用.xlsx
  const entries = readZip(zip([['a.pdf', Buffer.from('hello')], ['b.pdf', Buffer.from('x'.repeat(500)), { deflate: true }], ['', Buffer.from('z'), { gbk }], ['__MACOSX/x', Buffer.from('m')]]));
  assert.deepEqual(entries.map(e => e.name), ['a.pdf', 'b.pdf', '信用.xlsx']);
  assert.equal(entries[1].data.length, 500);
  assert.throws(() => readZip(zip([['../evil', Buffer.from('x')]])), /路径无效/);
  assert.throws(() => readZip(zip([['a', Buffer.from('1')], ['A', Buffer.from('2')]])), /重复/);
  assert.throws(() => readZip(Buffer.from('nope')), /ZIP/);
});
test('sourceRows validates direction, serials and dates', () => {
  const header = REQUIRED, line = id => REQUIRED.map(h => row(id)[h]);
  assert.equal(sourceRows([header, line(serial)])[0].serialNo, serial);
  assert.throws(() => sourceRows([header, line(serial), line(serial)]), /重复/);
  const bad = line(serial); bad[REQUIRED.indexOf('本方方向')] = '拆出';
  assert.throws(() => sourceRows([header, bad]), /不是拆入/);
  const date = line(serial); date[REQUIRED.indexOf('成交日期')] = '2026-02-30';
  assert.throws(() => sourceRows([header, date]), /日期无效/);
});
test('prepareArchive links PDFs, renames files and keeps leading-zero accounts', () => {
  const batch = prepareArchive(zip([['原始.xlsx', xlsx([row(serial), row(serial2, '20000')])], [`${serial}.pdf`, pdf(serial)], ['other.pdf', pdf(serial2)]]), pdfText);
  assert.equal(batch.date, '2026-10-16');
  assert.equal(batch.trades[0]['本方资金账号'], '000123');
  assert.deepEqual(batch.files.map(f => f.name), ['信用拆借成交查询_20261016.xlsx', `1016 上海农 1E ${serial}.pdf`, '1016 上海农 2E other.pdf']);
  assert.equal(batch.files[2].serialNo, serial2);
});
test('prepareArchive rejects unmatched PDFs and missing PDFs', () => {
  assert.throws(() => prepareArchive(zip([['a.xlsx', xlsx([row(serial)])], ['x.pdf', pdf(serial2)]]), pdfText), /不在 Excel/);
  assert.throws(() => prepareArchive(zip([['a.xlsx', xlsx([row(serial), row(serial2)])], ['x.pdf', pdf(serial)]]), pdfText), /未完整对应/);
  assert.throws(() => prepareArchive(zip([['a.xlsx', xlsx([row(serial)])], ['x.pdf', Buffer.from('%PDF none')]]), () => ''), /无法确定/);
  assert.throws(() => prepareArchive(zip([['x.pdf', pdf(serial)]]), pdfText), /一个 Excel/);
});
test('saveArchive is idempotent and never overwrites different files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ibo-selftest-'));
  try {
    const batch = prepareArchive(zip([['a.xlsx', xlsx([row(serial)])], ['x.pdf', pdf(serial)]]), pdfText);
    assert.deepEqual({ ...saveArchive(root, batch), dir: undefined }, { dir: undefined, written: 2, existing: 0 });
    assert.equal(saveArchive(root, batch).written, 0);
    const target = path.join(root, batch.date, batch.files[1].name);
    fs.writeFileSync(target, 'changed');
    assert.throws(() => saveArchive(root, batch), /已有不同文件/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'changed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('correctedRecords applies source values and rejects flagged rows', () => {
  const trades = sourceRows([REQUIRED, REQUIRED.map(h => row(serial)[h])]);
  const parsed = { status: 'SUCCESS', totalNum: 1, data: [{ serialNo: serial, days: 9, daysRedFlg: false }] };
  const [record] = correctedRecords(parsed, trades);
  assert.equal(record.interestRate, '0.0127');
  assert.equal(record.days, '7');
  assert.equal(record.ourpartyAccount, '000123');
  assert.throws(() => correctedRecords({ ...parsed, data: [{ serialNo: serial, daysRedFlg: true }] }, trades), /行校验未通过/);
  assert.throws(() => correctedRecords({ ...parsed, warnings: ['x'] }, trades), /解析未通过/);
  const two = sourceRows([REQUIRED, REQUIRED.map(h => row(serial)[h]), REQUIRED.map(h => row(serial2)[h])]);
  const dup = { status: 'SUCCESS', totalNum: 2, data: [{ serialNo: serial, serialNoRedFlg: true }, { serialNo: serial2 }] };
  assert.deepEqual(correctedRecords(dup, two, new Set([serial2])).map(r => r.serialNo), [serial2]);
  assert.throws(() => correctedRecords(dup, two), /行校验未通过/);
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => { const path_ = new URL(url).pathname; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ path: path_, body }); return Response.json({ code: 200, data: handler(path_, body) }); };
  return calls;
}
const camel = () => new Camel({ token: 't', tokenName: 'n', deviceId: 'd' });
test('importRecords posts the raw record array to excel/data/save', async () => {
  const records = [{ serialNo: serial, busiDate: '2026-10-16' }];
  const calls = mockFetch(path_ => path_.endsWith('/query') ? { records: [], total: 0 } : path_.endsWith('checkPublishAmount') ? { checkResult: true } : null);
  await camel().importRecords(records);
  const save = calls.find(c => c.path.endsWith('/excel/data/save'));
  assert.deepEqual(save.body, records);
  assert.ok(Array.isArray(save.body));
});
test('importRecords stops when the quota check fails or a trade already exists', async () => {
  mockFetch(path_ => path_.endsWith('/query') ? { records: [], total: 0 } : { checkResult: false });
  await assert.rejects(camel().importRecords([{ serialNo: serial, busiDate: '2026-10-16' }]), /额度检查未通过/);
  mockFetch(path_ => ({ records: [{ id: 1, serialNo: serial }], total: 1 }));
  await assert.rejects(camel().importRecords([{ serialNo: serial, busiDate: '2026-10-16' }]), /台账已存在/);
});
test('rows rejects duplicate serial numbers and paginates', async () => {
  mockFetch(() => ({ records: [{ id: 1, serialNo: serial }, { id: 2, serialNo: serial }], total: 2 }));
  await assert.rejects(camel().rows('2026-10-16'), /无效或重复/);
  let page = 0;
  mockFetch((_, body) => { page = body.current; return { records: [{ id: page, serialNo: `IBO2026101600000${page}` }], total: 2 }; });
  assert.equal((await camel().rows('2026-10-16')).length, 2);
});
test('zip decodes UTF-8 names without the UTF-8 flag', () => {
  const name = '成交.pdf';
  assert.equal(readZip(zip([[name, Buffer.from('x'), { gbk: Buffer.from(name) }]]))[0].name, name);
});

test('saveDraft distinguishes business errors from unknown outcomes', async () => {
  globalThis.fetch = async () => Response.json({ code: 500, message: 'rejected' });
  await assert.rejects(camel().saveDraft({}), e => e.outcomeUnknown !== true && /业务错误/.test(e.message));
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  await assert.rejects(camel().saveDraft({}), e => e.outcomeUnknown === true);
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
  await assert.rejects(camel().saveDraft({}), e => e.outcomeUnknown === true);
});
test('zip reads empty deflated files', () => {
  assert.equal(readZip(zip([['empty.txt', Buffer.alloc(0), { deflate: true }]]))[0].data.length, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(failed ? `${failed} 项失败` : `${tests.length} 项通过`);
process.exit(failed ? 1 : 0);
