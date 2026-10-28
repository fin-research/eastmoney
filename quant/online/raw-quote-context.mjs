import sources from './sources.json' with {type:'json'};
import { couponContext } from './coupon-features.mjs';
import { dayGap, validateIndustryProfile } from './issuance-features.mjs';
import { decodeCurveGrid } from './curve-grid.mjs';
import { pivot } from './features.mjs';
import { issuanceFeatures } from './issuance-features.mjs';

const bonds=['bond_code','short_name','issuer_name','bond_type','placement_type','interest_rate_type','original_tenor_years','final_coupon_pct','issue_date','tender_date','maturity_date'];
const issue=new Set(['rating','tenor','coupon','issue_size','issuance_rating']);
const treasury=new Set(['GOV_1Y','GOV_3Y','GOV_10Y']);
const quoteColumn=/^(?:(?:quote_h(?:1|14|30)_)?(?:sector|issuer)_quote_lag_(?:[0-9]|1[0-9])_bp|quote_h(?:1|14|30))$/;
export function validateRawQuoteDependencies(model) {
  if(model.candidate.kind!=='mlp'||model.candidate.feature_set!=='quote_history'||model.candidate.target!=='coupon'
    ||model.numeric.some(name=>!['tenor','issue_size','known_treasury_bp'].includes(name)&&!quoteColumn.test(name)))
    throw Error('Unsupported segmented coupon feature dependencies');
}
export function projectInputRows(records, date, terms, previous={}) {
  const datasets={},state={...previous};
  const append=(group,row)=>(datasets[group]??=[]).push(row);
  for(const {group,row,grid} of records){
    if(group==='industry_nodes'){
      const nodes=grid?decodeCurveGrid({...grid,rows:[row]}):decodeCurveGrid([row]);
      const node=nodes[0],key=[node.observation_date,Number(node.tenor_years)];
      if(node.observation_date>=date)throw Error('Unavailable industry_nodes inputs');
      if(!grid&&node.curve_code!=='5781a1ff7651967e0176978d957b7346')continue;
      if(node.observation_date>=date||state.nodeDate>key[0]||(state.nodeDate===key[0]&&state.nodeTenor>=key[1]))throw Error('Invalid segmented industry order');
      state.nodeDate=key[0];state.nodeTenor=key[1];
      if([1,3,5,7,10].includes(key[1]))append(group,[node.observation_date,node.tenor_years,node.yield_pct]);
      continue;
    }
    if(row.observation_date>=date||(row.published_date??'')>=date)throw Error(`Unavailable ${group} inputs`);
    switch(group){
      case 'funding': if(treasury.has(sources.funding[row.field]))append(group,row);break;
      case 'issue': if(issue.has(sources.issue[row.field]))append(group,row);break;
      case 'bond_issuance': append(group,Object.fromEntries(bonds.map(name=>[name,row[name]])));break;
      case 'issuer_daily': if(row.issuer===terms.issuer)append(group,row);break;
      case 'industry_curve': append(group,row);break;
      case 'macro': case 'primary': case 'secondary': break;
      default: throw Error('Unsupported segmented input group');
    }
  }
  if(datasets.issue)datasets.issue=pivot('issue',datasets.issue.map(row=>({...row,entity_key:row.entity_key.toUpperCase()})));
  return {datasets,state};
}
export function rawQuoteMarket(meta,datasets) {
  return issuanceFeatures({...meta,datasets:{funding:datasets.funding,industry_curve:datasets.industry_curve}},true);
}
export function rawQuoteRatings(rows,bonds,scope) {
  return rawQuoteRatingIndex(rows,rawQuoteCodes(bonds,scope));
}
export function rawQuoteCodes(bonds,scope) {
  return [...new Set(bonds.filter(row=>scope!=='public_only'||row.placement_type==='公募').map(row=>row.bond_code.toUpperCase()))];
}
export function rawQuoteRatingIndex(rows,allowedCodes) {
  const codes=new Set(allowedCodes);
  const merged=new Map();
  for(const row of rows){const key=JSON.stringify([row.date,row.bond_code]);merged.set(key,{...merged.get(key),...row});}
  return new Map([...merged.values()].filter(row=>codes.has(row.bond_code)&&['rating','tenor','coupon','issue_size'].every(name=>row[name]!=null))
    .sort((a,b)=>a.date.localeCompare(b.date)).map(row=>[row.bond_code,row.issuance_rating]));
}
export function buildRawQuoteContext(meta,datasets,manifest,prepared={}) {
  validateIndustryProfile(meta.industry_source_profile);
  const market=prepared.market??rawQuoteMarket(meta,datasets),ratings=prepared.ratings??rawQuoteRatings(datasets.issue,datasets.bond_issuance,manifest.issuance_scope);
  const dates=new Set(market.quotes.slice(-20).map(row=>row.date));
  const selected=datasets.industry_nodes.filter(row=>dates.has(row[0]));
  const nodes=selected.length?decodeCurveGrid({encoding:'curve-grid-v1',curve_code:meta.industry_source_profile.curveCode,curve_name:meta.industry_source_profile.curveName,rows:selected}):[];
  const context=couponContext({...meta,training_label_cutoff:manifest.training_label_cutoff,datasets:{...datasets,issue:[],industry_nodes:nodes}},manifest.issuance_scope,manifest.calendar,false,true,true,{market,ratings});
  return {...context,quotes:context.quotes.slice(-20),features:context.features.slice(-20),
    events:context.events.filter(row=>dayGap(meta.as_of_date,row.label_available_date)<=365),
    secondary:[...context.secondary],industryNodes:[...context.industryNodes].filter(([date])=>dates.has(date))};
}
export function restoreRawQuoteContext(value) {
  return {...value,secondary:new Map(value.secondary),industryNodes:new Map(value.industryNodes)};
}
