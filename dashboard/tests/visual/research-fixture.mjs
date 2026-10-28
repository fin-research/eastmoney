import {DASHBOARD_ECONOMIC_INDICATORS} from '../../src/lib/trading-research/economic-indicators.ts';
// Synthetic history exercises all visible chart series; these are not market observations.
export const researchHistory={asOf:'2026-09-15',syncedAt:'2026-09-15T08:00:00+08:00',rows:DASHBOARD_ECONOMIC_INDICATORS.flatMap((definition,index)=>Array.from({length:definition.frequency==='日频'?100:18},(_,i)=>{
  const daily=definition.frequency==='日频';
  const date=new Date(Date.UTC(2026,8,15)-(daily?99-i:(17-i)*30)*86400000).toISOString().slice(0,10);
  const base=definition.unit==='点'?3000:definition.unit.includes('元')?2600:definition.unit==='千人'?180:1.5+(index%7)*.3;
  const display=base*(1+.02*Math.sin(i*.55+index))+(daily?.001:.03)*i;
  return {code:definition.code,date,value:(display-(definition.offset??0))/(definition.factor??1)};
}))};
