import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBankCreditStatus } from '../src/lib/credit/bank-status.ts';
const row = (institutionName, institutionType, totalLimit = 10, totalUsed = 2, extra = {}) => ({
  institutionName, institutionType, totalLimit, totalUsed, status: 'approved', reportDate: '2026-06-30', expiryDate: null, ...extra,
});
test('bank table groups five natures, preserves unknown labels, and sums decimals', () => {
  const rows = [row('政策', '政策性银行'), row('国有甲', '国有银行', 0.1, 0.01), row('国有乙', '国有行', 0.2, 0.02),
    row('股份', '股份行'), row('城', '城商行'), row('农', '农商行'), row('外', '境外行及外资行'), row('民', '民营银行'),
    row('未知', '其他金融机构'), row('空性质', '')];
  const result = buildBankCreditStatus(rows);
  assert.deepEqual(result.groups.map(row => row.label), ['政策性银行', '国有银行', '股份制银行', '城、农商行', '其他（外资、境外、民营银行）', '其他金融机构', '未分类']);
  assert.deepEqual(result.groups[1], { label: '国有银行', totalLimit: 0.3, totalUsed: 0.03, remaining: 0.27 });
  assert.equal(result.groups[3].totalLimit, 20);
  assert.equal(result.groups[4].totalLimit, 20);
  assert.deepEqual(result.total, { totalLimit: 80.3, totalUsed: 16.03, remaining: 64.27 });
  assert.equal(rows[1].institutionType, '国有银行');
});
test('table uses report-day approvals, excluding expired and revoked institutions', () => {
  const rows = [row('当日到期', '国有行', 10, 2, { expiryDate: '2026-06-30' }),
    row('已到期', '国有行', 100, 99, { expiryDate: '2026-06-29' }),
    row('已撤销', '国有行', 100, 99, { expiryDate: '1970-01-01' }),
    row('申请中', '国有行', 100, 99, { status: 'applying' })];
  assert.deepEqual(buildBankCreditStatus(rows).total, { totalLimit: 10, totalUsed: 2, remaining: 8 });
  assert.equal(buildBankCreditStatus(rows.map(row => ({ ...row, reportDate: '2026-07-01' }))).topInstitutions.length, 0);
});
test('missing amounts stay missing; zero and negative usage remain valid', () => {
  const result = buildBankCreditStatus([row('零', '股份行', 0, 0), row('净卖出', '股份行', 3, -1), row('未关联', '国有行', 10, null), row('缺额度', '农商行', null, 1)]);
  assert.deepEqual(result.groups[2], { label: '股份制银行', totalLimit: 3, totalUsed: -1, remaining: 4 });
  assert.deepEqual(result.groups[1], { label: '国有银行', totalLimit: 10, totalUsed: null, remaining: null });
  assert.deepEqual(result.total, { totalLimit: null, totalUsed: null, remaining: null });
  assert.equal(result.topInstitutions.find(row => row.label === '零').remaining, 0);
  assert.equal(result.topInstitutions.find(row => row.label === '未关联').totalUsed, null);
  assert.equal(result.topInstitutions.some(row => row.label === '缺额度'), false);
});
test('top ten use total limits and stable names while keeping separate institutions', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`银行${i + 1}`, '国有行', 100 - i, i));
  rows.push(row('农银理财', '国有行', 500), row('农业银行', '国有行', 500));
  const result = buildBankCreditStatus(rows.reverse());
  assert.equal(result.topInstitutions.length, 10);
  assert.deepEqual(result.topInstitutions.slice(0, 2).map(row => row.label), ['农业银行', '农银理财']);
  assert.equal(result.topInstitutions.at(-1).label, '银行8');
  assert.deepEqual(buildBankCreditStatus([]).total, { totalLimit: 0, totalUsed: 0, remaining: 0 });
});
