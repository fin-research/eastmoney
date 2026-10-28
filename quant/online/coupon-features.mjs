import { curveDynamics, curveFeature } from './curve-dynamics.mjs';
import { issuanceFeatures, addDays, dayGap, calendar, industryAvailable } from './issuance-features.mjs';
import { pivot } from './features.mjs';
import { decodeCurveInputs } from './curve-grid.mjs';
const AAA_CURVE_CODE='5781a1ff7651967e0176978d957b7346';
const number=x=>x==null?NaN:Number(x);
const validDate=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const latest=(rows,date)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>1;if(rows[m].date<date)a=m+1;else b=m;}return rows[a-1];};
const treasury=(f,tenor)=>100*(tenor<=3?f.rate_gov_1y_level+(f.rate_gov_3y_level-f.rate_gov_1y_level)*(tenor-1)/2:f.rate_gov_3y_level+(f.rate_gov_10y_level-f.rate_gov_3y_level)*(tenor-3)/7);
function industryReference(nodes,tenor) {
  if(!nodes?.length||tenor<nodes[0].tenor||tenor>nodes.at(-1).tenor)return {value:null,gap:null};
  const upper=nodes.findIndex(row=>row.tenor>=tenor),right=nodes[upper],left=nodes[Math.max(upper-1,0)];
  const gap=right.tenor===tenor?0:right.tenor-left.tenor;
  return {value:100*(gap?left.yield+(right.yield-left.yield)*(tenor-left.tenor)/gap:right.yield),gap};
}
export function rawQuote(nodes,tenor) {
  const grid=[1,3,5,7,10];
  if(tenor<1||tenor>10)return null;
  const upper=grid.findIndex(t=>t>=tenor),right=grid[upper],left=grid[Math.max(upper-1,0)];
  const byTenor=new Map((nodes??[]).map(r=>[r.tenor,r.yield]));
  const b=byTenor.get(right),a=byTenor.get(left);
  if(tenor===right)return Number.isFinite(b)?100*b:null;
  if(!Number.isFinite(a)||!Number.isFinite(b))return null;
  return 100*(a+(b-a)*(tenor-left)/(right-left));
}
function weightedStats(rows,origin,tenor,column) {
  let sum=0,squares=0,premium=0;
  for(const e of rows) {
    const w=Math.exp(-Math.LN2*dayGap(origin,e.label_available_date)/90-Math.abs(e.tenor-tenor)/2);
    sum+=w;squares+=w*w;premium+=w*e[column];
  }
  return {mean:sum?premium/sum:null,latest:rows.at(-1)?.[column]??null,
    age:rows.length?dayGap(origin,rows.at(-1).label_available_date):null,
    neff:sum?sum*sum/squares:null,count:rows.length};
}
const shrunk=(own,peer,neff)=>own!=null&&peer!=null?neff/(neff+5)*own+5/(neff+5)*peer:own??peer;
export function issuanceKinds(rows) {
  const byCode=new Map(rows.map(r=>[r.bond_code,r]));
  const date=x=>{
    const parts=typeof x==='string'?x.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/):null;
    return parts?Date.parse(`${parts[1]}-${parts[2].padStart(2,'0')}-${parts[3].padStart(2,'0')}`):NaN;
  };
  return new Map(rows.map(r=>{
    const originalCode=r.bond_code.replace(/X\d*(?=\.(?:SH|SZ)$)/,'');
    const flagged=originalCode!==r.bond_code||/续|增发/.test(r.short_name??'');
    const original=originalCode!==r.bond_code?byCode.get(originalCode):null;
    const fixed=flagged&&original&&Number.isFinite(number(original.final_coupon_pct))
      &&number(original.final_coupon_pct)===number(r.final_coupon_pct)
      &&Number.isFinite(date(original.maturity_date))&&date(original.maturity_date)===date(r.maturity_date)
      &&date(original.issue_date)<date(r.issue_date)&&date(r.issue_date)<date(original.maturity_date)
      &&original.issuer_name===r.issuer_name&&original.bond_type===r.bond_type
      &&[original,r].every(x=>x.interest_rate_type==='固息');
    return [r.bond_code,fixed?'fixed_coupon_reopening':flagged?'unverified_reopening':'new_coupon'];
  }));
}
export function couponInputs(inputs, scope=inputs.issuance_scope??'all') {
  inputs=decodeCurveInputs(inputs);
  if(!['all','public_only'].includes(scope)||(inputs.issuance_scope!==undefined&&inputs.issuance_scope!==scope))throw new Error('Issuance scope mismatch');
  if(scope==='all')return inputs;
  const d=inputs.datasets,bonds=d.bond_issuance.filter(r=>r.placement_type==='公募'),codes=new Set(bonds.map(r=>r.bond_code.toUpperCase()));
  return {...inputs,issuance_scope:scope,datasets:{...d,bond_issuance:bonds,issue:d.issue.filter(r=>codes.has(r.entity_key.toUpperCase())),
    ...(d.issuer_daily?{issuer_daily:d.issuer_daily.filter(r=>r.placement_type==='公募')}:{})}};
}
export function couponContext(inputs,scope=inputs.issuance_scope??'all',calendarSpec=null,includeCurveDynamics=false,includeQuoteHistory=false,rawQuotesOnly=false,prepared={}) {
  inputs=couponInputs(inputs,scope);
  const market=prepared.market??issuanceFeatures(inputs,rawQuotesOnly), ratings=prepared.ratings??new Map(pivot('issue',inputs.datasets.issue.map(r=>({...r,entity_key:r.entity_key.toUpperCase()})))
    .filter(r=>r.rating!=null&&r.tenor!=null&&r.coupon!=null&&r.issue_size!=null)
    .map(r=>[r.bond_code,r.issuance_rating]));
  const events=[], kinds=issuanceKinds(inputs.datasets.bond_issuance);
  for(const r of inputs.datasets.bond_issuance) {
    if(kinds.get(r.bond_code)!=='new_coupon')continue;
    if(inputs.training_label_cutoff && r.issue_date>=inputs.training_label_cutoff)continue;
    const tenor=number(r.original_tenor_years),coupon=number(r.final_coupon_pct);
    if(!/\.(SH|SZ)$/.test(r.bond_code)||r.interest_rate_type!=='固息'||!(tenor>=1&&tenor<=10)||!['证券公司债','证券公司次级债'].includes(r.bond_type)||!validDate(r.tender_date)||!validDate(r.issue_date)||r.tender_date>r.issue_date||!(coupon>0&&coupon<30)||r.issue_date>=inputs.as_of_date) continue;
    const prior=latest(market.features,r.tender_date); if(!prior)continue;
    events.push({bond_code:r.bond_code,issuer:r.issuer_name||'未知',rating:ratings.get(r.bond_code)||'未知',bond_type:r.bond_type,placement_type:r.placement_type||'未知',tenor,label_available_date:r.issue_date,history_premium_bp:coupon*100-treasury(prior,tenor),coupon_bp:coupon*100,pricing_date:r.tender_date,pricing_quote_date:prior.date});
  }
  events.sort((a,b)=>a.label_available_date.localeCompare(b.label_available_date)||a.bond_code.localeCompare(b.bond_code));
  const secondary=new Map();
  for(const row of inputs.datasets.issuer_daily??[]) {
    const prior=latest(market.features,addDays(row.date,1));if(!prior)continue;
    const tenor=number(row.tenor_years),key=JSON.stringify([row.issuer,row.bond_type,row.placement_type]);
    const group=secondary.get(key)??[];
    group.push({...row,...(rawQuotesOnly?{}:{spread_bp:tenor>=1&&tenor<=10?number(row.yield_percent)*100-treasury(prior,tenor):NaN})});secondary.set(key,group);
  }
  for(const group of secondary.values())group.sort((a,b)=>a.date.localeCompare(b.date));
  const industryNodes=new Map();
  for(const row of inputs.datasets.industry_nodes??[]){
    if(row.curve_code!==AAA_CURVE_CODE)continue;
    const group=industryNodes.get(row.observation_date)??[];
    group.push({tenor:number(row.tenor_years),yield:number(row.yield_pct)});
    industryNodes.set(row.observation_date,group);
  }
  for(const group of industryNodes.values())group.sort((a,b)=>a.tenor-b.tenor);
  for(const event of rawQuotesOnly?[]:events) {
    const reference=industryReference(industryAvailable(event.pricing_date)?industryNodes.get(event.pricing_quote_date):[],event.tenor).value;
    event.industry_basis_bp=reference==null?null:event.coupon_bp-reference;
  }
  return {...market,events,secondary,industryNodes,calendarSpec,includeCurveDynamics,includeQuoteHistory,rawQuotesOnly,...(includeCurveDynamics?{curveDynamics:curveDynamics(market.features,industryNodes)}:{})};
}
export function couponFeature(context, request) {
  const origin=request.origin.slice(0,10),prior=latest(context.features,origin);
  if(!prior)throw new Error('Origin precedes market history');
  const target=addDays(origin,request.lead_days),day=new Date(target),month=day.getUTCMonth();
  const f={...prior}; delete f.date;
  for(const name of ['issuer','rating','bond_type','placement_type']) f[name]=request[name]||'未知';
  Object.assign(f,{tenor:request.tenor,issue_size:request.issue_size,lead_days:request.lead_days,
    pricing_weekday:(day.getUTCDay()+6)%7,pricing_month:month+1,
    pricing_month_end:new Date(Date.UTC(day.getUTCFullYear(),month+1,0)).getUTCDate()-day.getUTCDate(),
    known_treasury_bp:treasury(prior,request.tenor)});
  const targetQuote=target<=context.features.at(-1).date?latest(context.features,target)?.date:context.calendarSpec?calendar(context.calendarSpec).previous(target):null;
  if(targetQuote==null)throw new Error('Unavailable future quote calendar');
  f.market_known_zero=Number(targetQuote===prior.date);
  const nodes=industryAvailable(origin)?(context.industryNodes?.get(prior.date)??[]):[];
  const {value:industry,gap}=industryReference(nodes,request.tenor);
  Object.assign(f,{industry_aaa_tenor_bp:industry,
    industry_aaa_minus_treasury_bp:industry==null?null:industry-f.known_treasury_bp,
    industry_aaa_gap_years:gap,industry_aaa_quote_age_days:industry==null?null:dayGap(origin,prior.date),
    industry_aaa_available:Number(industry!=null)});
  if(context.includeCurveDynamics)Object.assign(f,curveFeature(industryAvailable(origin)?context.curveDynamics.get(prior.date):null,request.tenor));
  const mature=context.events.filter(e=>e.label_available_date<origin&&dayGap(origin,e.label_available_date)<=365);
  for(const [prefix,key] of [['issuer','issuer'],['peer','rating']]) {
    const rows=mature.filter(e=>e[key]===f[key]&&e.bond_type===f.bond_type&&e.placement_type===f.placement_type);
    f[`${prefix}_observations`]=rows.length;
    if(context.rawQuotesOnly)continue;
    f[`${prefix}_premium_mean_bp`]=rows.length?rows.reduce((a,r)=>a+r.history_premium_bp,0)/rows.length:null;
    f[`${prefix}_premium_latest_bp`]=rows.at(-1)?.history_premium_bp??null;
  }
  if(!context.rawQuotesOnly){
  const weighted=context.events.filter(e=>e.label_available_date<origin&&dayGap(origin,e.label_available_date)<=730);
  for(const [prefix,key] of [['issuer','issuer'],['peer','rating']]) {
    const rows=weighted.filter(e=>e[key]===f[key]&&e.bond_type===f.bond_type&&e.placement_type===f.placement_type);
    const stats=weightedStats(rows,origin,f.tenor,'history_premium_bp');
    f[`${prefix}_weighted_premium_bp`]=stats.mean;
    f[`${prefix}_weighted_latest_bp`]=stats.latest;
    f[`${prefix}_weighted_age_days`]=stats.age;
    f[`${prefix}_weighted_neff`]=stats.neff;
    const basis=weightedStats(rows.filter(e=>e.industry_basis_bp!=null),origin,f.tenor,'industry_basis_bp');
    f[`${prefix}_industry_basis_bp`]=basis.mean;
    f[`${prefix}_industry_basis_latest_bp`]=basis.latest;
    f[`${prefix}_industry_basis_age_days`]=basis.age;
    f[`${prefix}_industry_basis_neff`]=basis.neff;
    f[`${prefix}_industry_basis_observations`]=basis.count;
  }
  const own=f.issuer_weighted_premium_bp,peer=f.peer_weighted_premium_bp;
  f.issuer_shrunk_premium_bp=shrunk(own,peer,f.issuer_weighted_neff);
  f.issuer_shrunk_industry_basis_bp=shrunk(f.issuer_industry_basis_bp,f.peer_industry_basis_bp,f.issuer_industry_basis_neff);
  f.industry_basis_fallback=Number(industry==null||f.issuer_shrunk_industry_basis_bp==null);
  const secondary=context.secondary.get(JSON.stringify([f.issuer,f.bond_type,f.placement_type]))??[];
  const observation=latest(secondary,origin),index=observation?secondary.indexOf(observation):-1;
  const age=observation?dayGap(origin,observation.date):NaN;
  Object.assign(f,{issuer_secondary_spread_bp:age<=7?observation.spread_bp:null,
    issuer_secondary_change_20:age<=7&&index>=20?observation.spread_bp-secondary[index-20].spread_bp:null,
    issuer_secondary_age_days:observation?age:null,issuer_secondary_observations:observation?.observations??null,
    issuer_secondary_missing:observation?.missing_observations??null});
  }
  if(context.includeQuoteHistory){
    const secondary=context.secondary.get(JSON.stringify([f.issuer,f.bond_type,f.placement_type]))??[];
    const position=context.features.indexOf(prior),byDate=new Map(secondary.map(r=>[r.date,r]));
    for(let lag=0;lag<20;lag++){
      const quoteDate=context.features[position-lag]?.date;
      const rawNodes=quoteDate&&industryAvailable(origin)?(context.industryNodes.get(quoteDate)??[]).filter(r=>[1,3,5,7,10].includes(r.tenor)):[];
      f[`sector_quote_lag_${lag}_bp`]=rawQuote(rawNodes,f.tenor);
      for(const tenor of [1,3,5,7,10])f[`sector_${tenor}_quote_lag_${lag}_bp`]=rawQuote(rawNodes,tenor);
      const own=quoteDate?byDate.get(quoteDate):null;
      f[`issuer_quote_lag_${lag}_bp`]=own&&number(own.min_tenor)<=f.tenor&&f.tenor<=number(own.max_tenor)
        &&Number.isFinite(number(own.yield_intercept))&&Number.isFinite(number(own.yield_slope))
        ?100*(number(own.yield_intercept)+number(own.yield_slope)*f.tenor):null;
    }
  }
  return f;
}
