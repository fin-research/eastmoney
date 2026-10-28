import { buildBondLedgerAnalytics, toBondLedgerReport } from '../../src/lib/bond-ledger/analytics.ts';

const endDate='2026-09-15';
const dates=Array.from({length:84},(_,i)=>new Date(Date.UTC(2026,8,15)-(83-i)*86400000))
  .filter(date=>![0,6].includes(date.getUTCDay())).map(date=>date.toISOString().slice(0,10));
const performance=dates.map((date,i)=>({
  date,principal:10e8,timeWeightedPrincipal:10e8,marketValue:(12+i*.006+Math.sin(i*.4)*.03)*1e8,
  leverage:1.2+i*.0006,modifiedDuration:1.5+i*.003,dailyRevenue:80000+Math.sin(i*.8)*240000,
  cumulativeProfit:4000000+i*70000,ytdAnnualizedReturn:.023+i*.00002,ytdExTaxAnnualizedReturn:.021+i*.00002,
}));
const categories=['国债','政策性金融债','地方政府债','商业银行债','证券公司债','同业存单'];
const sources=performance.map((row,i)=>({date:row.date,performance:performance.slice(0,i+1),positions:categories.map((category,j)=>({
  reportDate:row.date,rowNumber:j+1,team:'测试团队',investmentManager:'测试',account:j<3?'交易户':'可供户',
  code:`26000${j+1}.IB`,market:'银行间',name:['26附息国债01','26国开01','26上海债01','26测试银行金融债01','26测试证券公开发行公司债券01','26测试银行同业存单001'][j],category,
  yieldChangeBp:-1,remainingYears:[.2,.8,1.5,2.5,4,7][j],interestStartDate:'2026-01-01',maturityDate:'2028-01-01',
  currentQuantity:2000000,pledgedQuantity:400000,availableQuantity:1600000,previousQuantity:2000000,
  buyQuantity:i>=dates.length-2&&j===0?200000:0,sellQuantity:i>=dates.length-2&&j===4?100000:0,maturityQuantity:i===dates.length-1&&j===5?50000:0,
  couponRate:2.1,valuationYield:1.8,reportYield:1.9,fullPrice:102,dv01:25000,
  marketValue:row.marketValue/6,couponIncome:5000,taxExemptIncome:1000,
  realizedProfit:j===4?12500:0,dailyProfit:row.dailyRevenue/6,ytdProfit:row.cumulativeProfit/6,fullPriceCost:100,
}))}));

export const ledgerAuditInventory={files:[{
  date:endDate,fileName:'二级池逐日台账-2026-09-15.xlsx',key:'fixture-ledger',size:286720,etag:'fixture',uploadedAt:'2026-09-15T09:00:00Z',
}],databaseDates:dates,availableStartDate:dates[0],availableEndDate:endDate};

export function ledgerAuditReport(start='2026-09-14',end=endDate){
  return toBondLedgerReport(buildBondLedgerAnalytics(sources,start,end));
}
