import assert from 'node:assert/strict';
import test from 'node:test';
import { governmentBondsSchema, marginBalancesSchema, primaryIssuesSchema, bondInfosSchema, favoriteQuotesSchema, omoOperationsSchema, cfetsRatesSchema, futuresQuotesSchema, todayTradesSchema } from '../src/data-contracts.ts';
import { buildReportData } from '../src/market-report-resources.ts';
import { reportDataSchema } from '../src/market-report.ts';
import { buildTextReport, briefOmo } from '../src/text-report.ts';
import { applyTextReportEdits } from '../src/text-report-editor.ts';
import { deriveReport } from '../src/report-view.ts';
import { coreMetricCards, omoSummaryItems } from '../src/view-model.ts';

const raw = () => ({
  reportDate: '2026-09-10', generatedAt: '2026-09-10T09:00:00+08:00', previousPrimaryDate: '2026-09-09',
  omo: [], dr: [], dibo: [], governmentBonds: [], futures: [], stock: { title: '', time: null, paragraphs: [] },
  margin: [], industry: { dataDate: '2026-09-10', equities: [], industries: [], turnoverYi: null, turnoverChangeYi: null, tradingDates: [] },
  primary: [], todayTrades: [], favoriteQuotes: [], bondInfos: [],
});

test('市场列表接受空容器与空行，必需标识缺失不拖累有效记录，错误结构仍拒绝', () => {
  for (const schema of [governmentBondsSchema, marginBalancesSchema, primaryIssuesSchema, bondInfosSchema, favoriteQuotesSchema, omoOperationsSchema, cfetsRatesSchema, futuresQuotesSchema, todayTradesSchema]) {
    for (const value of [null, undefined, [], [null, {}]]) assert.deepEqual(schema.parse(value), []);
    assert.throws(() => schema.parse('invalid'));
  }
  assert.deepEqual(primaryIssuesSchema.parse({ data: null }), []);
  assert.deepEqual(primaryIssuesSchema.parse({ data: { list: null } }), []);
  assert.equal(governmentBondsSchema.parse([{ bondCode: null }, { bondCode: '260010.IB', yield: 0 }]).length, 1);
  assert.throws(() => governmentBondsSchema.parse([{ bondCode: '260010.IB', yield: 'broken' }]));
});

test('两融保留最新日期和其他余额，空值只阻断对应的变动计算', () => {
  const resources = raw();
  resources.margin = marginBalancesSchema.parse([
    { DIM_DATE: '2026-09-10', TOTAL_RZRQYE: null, TOTAL_RZYE: 10e8, TOTAL_RQYE: 0 },
    { DIM_DATE: '2026-09-09', TOTAL_RZRQYE: 9e8, TOTAL_RZYE: 8e8, TOTAL_RQYE: 1e8 },
  ]);
  const report = reportDataSchema.parse(buildReportData(resources));
  assert.equal(report.margin.data_date, '2026-09-10');
  assert.equal(report.margin.total, null);
  assert.equal(report.margin.total_change, null);
  assert.equal(report.margin.financing, 10);
  assert.equal(report.margin.financing_change, 2);
  assert.equal(report.margin.securities_lending, 0);
});

test('发行规模缺失仍保留债券明细，汇总及文字版不误报为零或无发行', () => {
  const resources = raw();
  resources.primary = primaryIssuesSchema.parse([
    { bidStartDate: null, issueStartDate: '2026-09-10', comShortName: '测试证券', bondShortName: '26测试01', issueTenor: '1Y', planIssueAmount: 10 },
    { bidStartDate: '2026-09-10', comShortName: '测试证券', bondShortName: '26测试02', issueTenor: '2Y', planIssueAmount: null, issueCouponRate: null },
  ]);
  const report = reportDataSchema.parse(buildReportData(resources));
  assert.equal(report.primary_summary.current_amount, null);
  assert.equal(report.primary_summary.change_amount, null);
  assert.equal(report.primary_issues.length, 2);
  assert.ok(report.primary_issues.some(row => row.amount === null));
  const text = buildTextReport(report);
  assert.match(text, /规模暂缺/);
  const edited = applyTextReportEdits(report, '', text.replace('规模暂缺--', '规模暂缺-2.00%'));
  assert.deepEqual(edited.issues, []);
  assert.equal(edited.data.primary_summary.current_amount, null);
  assert.ok(edited.data.primary_issues.some(row => row.amount === null && row.coupons[0] === 2));
  assert.ok(!text.split('【一级发行】')[1].split('【二级行情】')[0].includes('今日暂无'));
  assert.equal(coreMetricCards(report, deriveReport(report)).find(row => row.label === '同业发行').value, '—');
});

test('含权或缺失期限不阻断完整发行规模，金额缺失仍只阻断对应日期汇总', () => {
  const resources = raw();
  resources.primary = primaryIssuesSchema.parse([
    ...['5+2', '3+2', '1+1', null].map((issueTenor, index) => ({
      bidStartDate: resources.reportDate, comShortName: '测试证券',
      bondShortName: `26测试0${index + 1}`, issueTenor, planIssueAmount: 30,
    })),
    { bidStartDate: resources.reportDate, comShortName: '其他证券', bondShortName: '26其他01', issueTenor: '180D', planIssueAmount: 60 },
    { bidStartDate: resources.previousPrimaryDate, comShortName: '测试证券', bondShortName: '26测试前日', issueTenor: '3+2', planIssueAmount: 30 },
    { bidStartDate: resources.reportDate, comShortName: '东方财富证券', bondShortName: '26东财01', issueTenor: null, planIssueAmount: null },
    { bidStartDate: '2026-09-08', comShortName: '测试证券', bondShortName: '26测试旧券', issueTenor: null, planIssueAmount: null },
  ]);
  const report = reportDataSchema.parse(buildReportData(resources));
  assert.deepEqual(report.primary_summary, { current_amount: 180, change_amount: 150 });
  assert.equal(report.primary_issues.filter(row => row.issue_date_key === resources.reportDate)
    .reduce((sum, row) => sum + row.amount, 0), 180);
  const card = coreMetricCards(report, deriveReport(report)).find(row => row.label === '同业发行');
  assert.equal(card.value, '180 亿');
  assert.equal(card.detail, '+150 亿');

  resources.primary[5].planIssueAmount = null;
  assert.deepEqual(buildReportData(resources).primary_summary, { current_amount: 180, change_amount: null });
  resources.primary[0].planIssueAmount = null;
  assert.deepEqual(buildReportData(resources).primary_summary, { current_amount: null, change_amount: null });
});

test('未知交易日不阻止当日发行，但不推测环比；缺少科创标志不误入普通公募公司债', () => {
  const resources = raw();
  resources.previousPrimaryDate = '';
  resources.primary = [{ bidStartDate: '2026-09-10', comShortName: '测试证券', bondShortName: '26测试01', issueTenor: '1Y', planIssueAmount: 10 }];
  resources.todayTrades = [{ bondUniCode: '123', remainingTenor: '3Y', tradeYield: 2 }];
  resources.bondInfos = bondInfosSchema.parse([{ bondUniCode: '123', bondShortName: '26测试01', comShortName: '测试证券', bondType: 37, bondOfferingType: 1, sciTechInnoBondStatus: null }]);
  const report = reportDataSchema.parse(buildReportData(resources));
  assert.equal(report.primary_summary.current_amount, 10);
  assert.equal(report.primary_summary.change_amount, null);
  assert.deepEqual(report.secondary_bonds, []);
});

test('操作金额缺失不会形成部分净投放、跨日累计或未开展操作的结论', () => {
  const resources = raw();
  resources.omo = [{ operationDate: '2026-09-10', operationName: '逆回购', duration: '7D', operationAmount: 10, interestRate: 1.4 },
    { operationDate: '2026-09-10', operationName: '逆回购到期', duration: '7D', operationAmount: null, interestRate: null }];
  const report = buildReportData(resources);
  const derived = deriveReport(report);
  assert.equal(derived.omoHistory[0].net_amount, null);
  assert.equal(coreMetricCards(report, derived)[0].value, '—');
  assert.match(briefOmo(report.omo_operations, report.report_date), /暂缺/);
  assert.ok(omoSummaryItems(derived.omoHistory, report.report_date).every(item => !item.value.includes('10')));
});

test('报价简称为空时仍使用债券基础信息中的已知简称', () => {
  const resources = raw();
  resources.favoriteQuotes = favoriteQuotesSchema.parse([{ bondUniCode: '123', bondShortName: null, remainingTenor: '1Y', remainingTenorDay: 365, cbYield: 1.8 }]);
  resources.bondInfos = bondInfosSchema.parse([{ bondUniCode: '123', bondShortName: '26测试01', comShortName: null, bondType: null, bondOfferingType: null, sciTechInnoBondStatus: null }]);
  const report = buildReportData(resources);
  assert.equal(report.inventory_bonds[0].bond_name, '26测试01');
});
