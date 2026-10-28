import {creditDataFixture} from '../helpers/credit-data-fixture.mjs';
import { buildReportData } from "../../src/market-report-resources.ts";
import { financingModel } from './report-fixtures.mjs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildBondLedgerAnalytics, toBondLedgerReport, emptyBondLedgerReport } from '../../src/lib/bond-ledger/analytics.ts';

export const today = '2026-09-15';
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../../migrations/1015_trading_workflow_config.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../../migrations/1016_trading_workflow_graph.sql', import.meta.url), 'utf8'));
export const workflow = { version: 2, ...JSON.parse(db.prepare('SELECT nodes FROM trading_workflow_config').get().nodes), actorKey: 'visual-fixture', canEdit: true };
db.close();
const summary = { reportDate: today, institutionCount: 2, approvedCount: 2, totalLimit: 30, totalUsed: 8, totalAvailable: 22, utilization: 26.67, expiringWithin30Days: 1 };
export const credit = {
  availableDates: [today, '2026-09-08'], previousDate: null, summary, previousSummary: null,
  weeklySummary: { ...summary, addedInstitutionCount: 1, expiredInstitutionCount: 0 }, previousWeeklySummary: null,
  institutions: ['银行甲', '银行乙'].map((institutionName, i) => ({
    reportDate: today, institutionName, institutionType: '商业银行', status: 'approved',
    confidentialityStatus: false, totalLimit: 15, totalUsed: 4, totalRemaining: 11,
    availableAmount: 11, utilization: 26.67, effectiveDate: i ? '2026-01-01' : today, expiryDate: i ? '2027-09-15' : '2026-09-30', items: [], clients: [{id:'fixture-client-'+i,name:'测试关联客户'}], notes: null,
  })),
  weeklyNews: [], recentApprovals: [{reportDate:today,institutionName:'银行甲',eventType:'new',previousAmount:0,currentAmount:15,previousEffectiveDate:null,currentEffectiveDate:today,previousExpiryDate:null,currentExpiryDate:'2026-09-30'}], limitChanges: [], usageChanges: [],
  calendarEvents: [
    { id: 'new', type: 'added', kind: 'new', institutionName: '银行甲', label: '新增授信15亿元', date: '2026-09-15', status: 'completed', statusLabel: '已生效' },
    { id: 'expiry', type: 'expiry', kind: 'expiry', institutionName: '银行乙', label: '授信到期', date: '2026-09-30', status: 'planned', statusLabel: '待办理' },
  ],
};

const performance = Array.from({ length: 6 }, (_, index) => ({
  date: `2026-09-${String(10 + index).padStart(2, '0')}`, principal: 10e8,
  timeWeightedPrincipal: 10e8, marketValue: (12 + index / 10) * 1e8,
  leverage: 1.2 + index / 100, modifiedDuration: 1.5,
  dailyRevenue: 200000 + index * 10000, cumulativeProfit: 4000000 + index * 200000,
  ytdAnnualizedReturn: 2.3, ytdExTaxAnnualizedReturn: 2.1,
}));
const position = { reportDate: today, rowNumber: 1, team: '测试团队', investmentManager: '测试',
  account: '交易户', code: '260001.IB', market: '银行间', name: '测试国债', category: '国债',
  yieldChangeBp: -1, remainingYears: 1.5, interestStartDate: '2026-01-01', maturityDate: '2028-01-01',
  currentQuantity: 10000000, pledgedQuantity: 2000000, availableQuantity: 8000000, previousQuantity: 10000000,
  buyQuantity: 0, sellQuantity: 0, maturityQuantity: 0, couponRate: 2.1, valuationYield: 1.8,
  reportYield: 1.9, fullPrice: 102, dv01: 150000, marketValue: 102e7,
  couponIncome: 50000, taxExemptIncome: 10000, realizedProfit: 0,
  dailyProfit: 200000, ytdProfit: 5000000, fullPriceCost: 100 };
const ledger = toBondLedgerReport(buildBondLedgerAnalytics(
  performance.map(row => ({ date: row.date, performance: performance.filter(p => p.date <= row.date),
    positions: [{ ...position, reportDate: row.date, marketValue: row.marketValue, dailyProfit: row.dailyRevenue }] })), '2026-09-10', today));

export const marketSnapshot = {
  ...buildReportData({
    reportDate: today, generatedAt: `${today}T17:00:00+08:00`, previousPrimaryDate:'2026-09-14',
    industry: { dataDate: today, equities: [{ name:'上证指数',close:3610.2,change_pct:0.4 }], industries:[{name:'银行',change_pct:1.2,market_cap_yuan:9.8e12},{name:'电子',change_pct:-0.6,market_cap_yuan:8e12}],turnoverYi:15000,turnoverChangeYi:200,tradingDates:['2026-09-14',today] },
    stock:{title:'A股收评',time:`${today}T15:00:00+08:00`,paragraphs:['市场交投平稳，资金面保持均衡。','后续关注政策落地与资金价格变化。']},
    omo:[{operationDate:today,operationName:'逆回购',duration:'7D',interestRate:1.4,operationAmount:1000}],
    dr:[{bondCode:'DR007',weightedYield:1.5,weightedYieldUpDownValueBp:-2}],
    dibo:[{bondCode:'R007',weightedYield:1.5,weightedYieldUpDownValueBp:-2}],
    governmentBonds:[{bondCode:'260010.IB',ordinateName:'国债',abscissaName:'10Y',tradeNum:12,yield:1.8,yieldSubYtdCloseBp:-1}],
    futures:[{contractCode:'T9999',lastPrice:106.5,upDownValuePct:0.15}],
    margin:[{DIM_DATE:today,TOTAL_RZRQYE:2e12,TOTAL_RZYE:1.99e12,TOTAL_RQYE:1e10},{DIM_DATE:'2026-09-14',TOTAL_RZRQYE:1.999e12,TOTAL_RZYE:1.9891e12,TOTAL_RQYE:9.9e9}],
    primary:[],todayTrades:[],favoriteQuotes:[],bondInfos:[],
  }),
  focus_text:'1、市场交投平稳，资金面保持均衡。\n2、后续关注政策落地与资金价格变化。',
  cached_at:`${today}T17:00:00+08:00`,finalized_at:`${today}T17:00:00+08:00`,
};

export async function mockResources(page, { creditError = false, ledgerEmpty = false } = {}) {
  const unexpected = [];
  let progress = null;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:8877') {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/data/')) return route.continue();
    let body;
    if (url.pathname === '/api/trading-workflow/day') {
      const empty={date:today,enabled:{loan:true,reverse:true,exchange:false},completed:{},branches:{}};
      if(request.method()==='PUT') { const patch=request.postDataJSON(),old=progress??empty;progress={...old,enabled:{...old.enabled,...patch.enabled},completed:{...old.completed,...patch.completed},branches:{...old.branches,...patch.branches}}; }
      return route.fulfill({json:{state:progress??empty,revision:progress?1:0}});
    }
    if (url.pathname === '/api/credit') {
      if (creditError) return route.fulfill({ status: 503, json: { error: '授信报表暂不可用' } });
      body = creditDataFixture(credit);
    } else if (url.pathname === '/api/market-report') body = marketSnapshot;
    else if (url.pathname === '/api/financing-model') body = financingModel;
    else if (url.pathname === '/api/financing-model/decisions') body = [];
    else if (url.pathname === '/api/trading-workflow/config') body = workflow;
    else if (url.pathname === '/data/chinamoney/shibor') body = [{ publishDate: today, publishedAt: `${today}T11:00:00+08:00`, tenor: '1W', rate: 1.5 }];
    else if (url.pathname === '/api/economic-indicators') body = { asOf: today, syncedAt: `${today}T08:00:00+08:00`, rows: [
      { code: 'E1300004', date: '2026-09-14', value: 1.4 }, { code: 'E1300004', date: today, value: 1.45 },
      { code: 'EMI01737210', date: '2026-07-31', value: 101.8 }, { code: 'EMI01737210', date: '2026-08-31', value: 102.1 },
    ] };
    else if (url.pathname === '/api/bond-ledger') body = url.searchParams.has('start')
      ? ledgerEmpty ? emptyBondLedgerReport() : ledger
      : { files: [], databaseDates: ledgerEmpty ? [] : [today], availableStartDate: ledgerEmpty ? null : today, availableEndDate: ledgerEmpty ? null : today };
    else if (url.pathname === '/data/industry') body = { dataDate: today, equities: [{ name: '上证指数', close: 3610.2, change_pct: 0.4 }], industries: [{ name: '银行', change_pct: 1.2, market_cap_yuan: 9.8e12 }, { name: '电子', change_pct: -0.6, market_cap_yuan: 8e12 }], turnoverYi: 15000, turnoverChangeYi: 200, tradingDates: ['2026-09-14', today] };
    else if (url.pathname === '/data/stock-summary') body = { title: 'A股收评', time: `${today}T15:00:00+08:00`, paragraphs: ['市场交投平稳，资金面保持均衡。', '后续关注政策落地与资金价格变化。'] };
    else if (url.pathname === '/data/omo') body = [{ operationDate: today, operationName: '逆回购', duration: '7D', interestRate: 1.4, operationAmount: 1000 }];
    else if (url.pathname === '/data/cfets') body = [{ bondCode: url.searchParams.get('source') === 'DR' ? 'DR007' : 'R007', weightedYield: 1.5, weightedYieldUpDownValueBp: -2 }];
    else if (url.pathname === '/data/bond-top-case') body = [{ bondCode: '260010.IB', ordinateName: '国债', abscissaName: '10Y', tradeNum: 12, yield: 1.8, yieldSubYtdCloseBp: -1 }];
    else if (url.pathname === '/data/futures-latest') body = [{ contractCode: 'T9999', lastPrice: 106.5, upDownValuePct: 0.15 }];
    else if (url.pathname === '/data/margin') body = [
      { DIM_DATE: today, TOTAL_RZRQYE: 2e12, TOTAL_RZYE: 1.99e12, TOTAL_RQYE: 1e10 },
      { DIM_DATE: '2026-09-14', TOTAL_RZRQYE: 1.999e12, TOTAL_RZYE: 1.9891e12, TOTAL_RQYE: 9.9e9 },
    ];
    else if ([ '/data/primary-issues', '/data/today-trades', '/data/favorite-quotes'].includes(url.pathname)) body = [];
    else {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: 'Unregistered test resource' } });
    }
    if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: 'Unexpected mutation' } });
    }
    return route.fulfill({ json: structuredClone(body) });
  });
  return unexpected;
}
