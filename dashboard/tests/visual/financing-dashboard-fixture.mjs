import {managementAudit} from './management-fixtures.mjs';
import {liabilityAudit} from './liability-fixture.mjs';
const types=['小公募','次级债','短期融资券','固定收益凭证','同业拆借','互换便利','浮动收益凭证','集团借款','转融资'];
const composition=types.map((type,i)=>({type,amountYi:[180,90,70,60,45,30,15,8,2][i]??0}));
/** @param {URL} url */
export function financingDashboardData(url){
 const preset=url.searchParams.get('preset')??'all';
 /** @type {Record<string,string[]>} */
 const exclusions={all:[],no_interbank:['同业拆借'],no_interbank_swap:['同业拆借','互换便利'],core_financing:['同业拆借','互换便利','浮动收益凭证']};
 const selectedTypes=preset==='custom'?url.searchParams.getAll('type'):types.filter(type=>!(exclusions[preset]??[]).includes(type));
 const selected=composition.filter(row=>selectedTypes.includes(row.type));
 return {...managementAudit,reminders:{items:[],total:0},preset,selectedTypes,dashboard:{
 selectedTypes,parameters:liabilityAudit.parameters,asOfDate:'2026-09-15',today:'2026-09-15',calendarMonth:'2026-09',typeOptions:types,composition:selected,
 metrics:{...liabilityAudit.metrics,balanceYi:selected.reduce((sum,row)=>sum+row.amountYi,0),projectAmountYi:60,cumulativeBorrowingDate:'2026-08-31'},
 projects:[{id:'project-1',debtType:'小公募',name:'2026年面向专业投资者公开发行公司债券（第二期）',amountYi:30,tenor:'3年、5年',cost:'1.90%–2.20%',landingDate:'2026-09-22'},{id:'project-2',debtType:'短期融资券',name:'2026年短期融资券项目',amountYi:30,tenor:'270天',cost:'1.65%–1.85%',landingDate:'2026-10-15'}],
 maturityDistribution:Array.from({length:6},(_,i)=>({month:new Date(Date.UTC(2026,8+i,1)).toISOString().slice(0,7),amountYi:20+i*7})),
 monthlyIssuance:{currentMonth:'2026-09',comparisonMonth:'2026-08',rows:types.slice(0,5).map((label,i)=>({label,currentYi:10+i*2,comparisonYi:8+i*3}))},
 limits:types.slice(0,4).map((debtType,i)=>({debtType,limitYi:200-i*20,issuedYi:80-i*10,remainingYi:120-i*10,approvedDate:'2026-01-15',expiryDate:'2028-01-15'})),limitTotals:{limitYi:680,issuedYi:260,remainingYi:420},financeParameterReminder:false,
 events:[...Array.from({length:8},(_,i)=>({id:`maturity:${i}`,date:`2026-09-${String(15+i).padStart(2,'0')}`,filterType:types[i%types.length],amountYi:5,tone:'teal',href:'/debts/1',title:`26东财证券${String(i+1).padStart(2,'0')}•本金到期5亿元`})),...Array.from({length:5},(_,i)=>({id:`interest:extra-${i}`,date:'2026-09-15',filterType:'小公募',amountYi:.1,tone:'orange',href:'/debts/1',title:`26测试证券${i+1}•债券付息0.1亿元`}))]
 }};
}
