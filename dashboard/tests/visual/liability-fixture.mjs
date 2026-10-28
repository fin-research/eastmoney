import {emptyLiabilityWeeklyReport} from '../../src/lib/financing/liability-report-data.js';
import {issuanceTrendTypes} from '../../src/charts/financing/report.ts';
const types=['公募债','次级债','短期融资券','收益凭证','同业拆借'];
const parameters=Object.fromEntries(Object.entries({total_assets:1600,total_liabilities:1100,adjusted_asset_liability_ratio:.63,prior_month_net_capital:320,securities_prior_year_net_assets:420,group_prior_year_net_assets:650}).map(([key,valueYi])=>[key,{valueYi}]));
const metrics={balanceYi:500,balanceMonthChangeYi:12,balanceYearChangeYi:45,weightedRatePct:2.12,weightedRateMonthBp:-3,weightedRateYearBp:-18,weightedRemainingDays:650,remainingMonthChangeDays:12,remainingYearChangeDays:35,longBalanceRatio:72,longBalanceYi:360,shortBalanceYi:140,due30Yi:30,dueYearYi:85,shortCompanyDebtRatio:35,shortCompanyDebtYi:112,shortDebtRatio:44,shortDebtYi:140.8,largestBorrowingRatio:8,largestBorrowingYi:33.6,cumulativeSecuritiesRatio:28,cumulativeGroupRatio:18,cumulativeBorrowingYi:117.6};
const composition=types.map((type,i)=>({type,amountYi:[240,120,70,40,30][i]}));
const limits=types.slice(0,4).map((debtType,i)=>({debtType,limitYi:200-i*20,issuedYi:80-i*10,remainingYi:120-i*10,approvedDate:'2026-01-15',rule:'按批复有效期使用'}));
const limitTotals={limitYi:680,issuedYi:260,remainingYi:420};
const events=Array.from({length:6},(_,i)=>({id:String(i),week:i<3?'current':'next',kind:['issue','maturity','interest'][i%3],date:i<3?'2026-09-15':'2026-09-22',name:['26东财证券01','吉祥231号收益凭证','25东财证券次级债'][i%3],debtType:'公募债',amountYi:i%3===2?.15:10}));
const projects=[{name:'2026年面向专业投资者公开发行公司债券（第二期）',debtType:'公募债',amountYi:30,tenorDescription:'3年、5年',plannedIssueDate:'2026-09-22',expectedRateMin:.019,expectedRateMax:.022}];
const balanceRateTrend=Array.from({length:69},(_,i)=>({date:new Date(Date.UTC(2021,0+i,1)).toISOString().slice(0,10),balanceYi:260+i*3.5+10*Math.sin(i*.4),weightedRatePct:3.5-i*.018+.1*Math.sin(i*.5)}));
const issuanceTrend=Array.from({length:12},(_,i)=>issuanceTrendTypes.map((type,j)=>({month:new Date(Date.UTC(2025,9+i,1)).toISOString().slice(0,7),type,amountYi:2+j+i%3,weightedRatePct:1.7+j*.11+.04*Math.sin(i)}))).flat();
const maturityDistribution=Array.from({length:12},(_,i)=>({month:new Date(Date.UTC(2026,8+i,1)).toISOString().slice(0,7),amountYi:20+i}));
const maturityByType=maturityDistribution.flatMap(({month},i)=>types.map((type,j)=>({month,type,amountYi:2+j+i%4})));
const annualMaturity=['2026','2027','2028','2029','2030及以后'].flatMap((bucket,i)=>types.map((type,j)=>({bucket,type,amountYi:5+j*2+i*4})));
const dueDetails=types.slice(0,4).map((debt_type,i)=>({id:String(i+1),debt_type,counterparty:'测试银行金融市场部',principalYi:7.5,interestYi:.08,annualRatePct:2.05,dueDate:'2026-09-30'}));
const peers=['东方财富证券','国泰海通证券','中信证券','华泰证券','招商证券','中国银河证券','申万宏源证券','广发证券'];
const peerIssueSummary=peers.flatMap((issuerName,i)=>['公募债','次级债','短期公司债','短期融资券'].map((bondType,j)=>({issuerName,bondType,amountYi:10+i*6+j*4})));
const peerIssuances=peers.slice(0,4).map((issuerName,i)=>({issuerName,bondType:'公募债',actualIssueAmountYi:20+i*5,issueTenor:'3年',couponRatePct:2.05+i*.02,issueDate:'2026-09-15'}));
const registrationProgress=Array.from({length:14},(_,i)=>({issuerName:peers[i%8],variety:'公募债',amountYi:100+i*10,status:i%2?'已受理':'注册生效',updateDate:'2026-09-15'}));
const marketHistory=['chinabond_broker_aaa_minus_yield','state_owned_bank_ncd','credit_spread_broker_govt_1y','credit_spread_broker_govt_3y','credit_spread_broker_govt_5y'].flatMap(category=>Array.from({length:100},(_,i)=>{
 const observationDate=new Date(Date.UTC(2026,5,8+i)).toISOString().slice(0,10);
 return (category.startsWith('credit_spread')?['AAA-券商债','国债','信用利差']:['1年','2年','3年','5年']).map((seriesName,j)=>({category,seriesId:category+j,seriesName,tenor:seriesName,observationDate,unit:seriesName==='信用利差'?'bp':'%',value:seriesName==='信用利差'?25+4*Math.sin(i*.12):1.5+j*.17+.05*Math.sin(i*.1+j)}));
})).flat();

export const liabilityAudit={...emptyLiabilityWeeklyReport('2026-09-15'),parameters,metrics,composition,limits,limitTotals,events,projects,balanceRateTrend,issuanceTrend,maturityDistribution,maturityByType,annualMaturity,dueDetails,peerIssueSummary,peerIssuances,registrationProgress,marketHistory};
