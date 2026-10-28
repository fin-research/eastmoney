import { predict, explain } from './tree.mjs';
export function couponAnchor(model, vector, treasury) {
  const read=name=>vector[model.feature_names.indexOf(name)];
  const finite=x=>x!=null&&Number.isFinite(x);
  switch(model.candidate.target) {
    case 'coupon': return 0;
    case 'excess': return treasury;
    case 'pricing_excess':
    case 'industry_excess': {
      const reference=read('industry_aaa_tenor_bp');
      return read('industry_aaa_available')===1&&finite(reference)?reference:treasury;
    }
    case 'primary_residual':
    case 'industry_basis_residual': {
      const own=read('issuer_shrunk_premium_bp'),peer=read('peer_premium_mean_bp');
      const fallback=treasury+(finite(own)?own:finite(peer)?peer:0);
      if(model.candidate.target==='primary_residual')return fallback;
      const industry=read('industry_aaa_tenor_bp'),basis=read('issuer_shrunk_industry_basis_bp');
      return read('industry_aaa_available')===1&&finite(industry)&&finite(basis)?industry+basis:fallback;
    }
    default: throw new Error('unknown coupon target');
  }
}
export function encodeCoupon(model, feature) {
  if(['quote_static','quote_history','quote_pca','quote_product','quote_primary_batch'].includes(model.candidate.feature_set)){
    feature={...feature};
    const projection=model.curve_projection;
    if(model.candidate.feature_set==='quote_pca'){
      const values=projection.columns.map(name=>feature[name]);
      const complete=values.every(x=>x!=null&&Number.isFinite(x));
      for(let i=0;i<3;i++)feature[`curve_pc_${i}`]=complete?values.reduce((sum,x,j)=>sum+(x-projection.mean[j])*projection.components[i][j],0):null;
    }
    if(model.candidate.feature_set==='quote_product'){
      const contrast=model.product_quote.contrast[feature.bond_type]??0;
      const quote=feature.sector_quote_lag_0_bp;
      feature.product_sector_quote=contrast===0?0:Number.isFinite(quote)?contrast*(quote-model.product_quote.sector_mean_bp):null;
    }
    const columns=['quote_history','quote_product','quote_primary_batch'].includes(model.candidate.feature_set)
      ?['sector','issuer'].flatMap(source=>Array.from({length:20},(_,lag)=>`${source}_quote_lag_${lag}_bp`))
      :['sector_quote_lag_0_bp','issuer_quote_lag_0_bp',...(projection?['curve_pc_0','curve_pc_1','curve_pc_2']:[])];
    for(const h of [1,14,30]){
      const active=feature.lead_days===h;
      feature[`quote_h${h}`]=Number(active);
      for(const column of columns){
        feature[`quote_h${h}_${column}`]=active?feature[column]:0;
      }
    }
  }
  const vector=model.numeric.map(name=>Number.isFinite(feature[name])?feature[name]:null);
  for(const name of ['issuer','rating','bond_type','placement_type']) {
    if(name==='issuer'&&model.candidate.feature_set==='combined_no_issuer')continue;
    const code=model.categories[name][feature[name]]??-1;
    if(model.candidate.kind==='lgb') vector.push(code);
    else for(const index of Object.values(model.categories[name])) vector.push(Number(code===index));
  }
  return vector;
}
export function couponPrediction(model, vector, anchor) {
  let value;
  if(model.mlp) value=mlpParts(model.mlp,vector).prediction;
  else if(model.linear) {
    const m=model.linear;
    value=m.intercept+vector.reduce((sum,x,i)=>sum+((Number.isFinite(x)?x:m.fill[i])-m.center[i])/m.scale[i]*m.coefficients[i],0);
  } else value=predict(model,vector);
  return value+couponAnchor(model,vector,anchor)+marketParts(model,vector).change;
}
export function couponExplanation(model, vector, anchor) {
  const result=model.mlp?mlpExplanation(model.mlp,vector):model.linear?{
    values:vector.map((x,i)=>((Number.isFinite(x)?x:model.linear.fill[i])-model.linear.center[i])/model.linear.scale[i]*model.linear.coefficients[i]),
    expected:model.linear.intercept,
  }:explain(model,vector);
  result.expected+=couponAnchor(model,vector,anchor);
  const market=marketParts(model,vector);
  for(const [name,value] of market.parts)result.values[model.feature_names.indexOf(name)]+=value;
  result.expected+=market.base;
  if(model.anchor_reference){
    const treasury=vector[model.feature_names.indexOf('known_treasury_bp')];
    const spread=couponAnchor(model,vector,anchor)-treasury;
    for(const [name,value] of [['known_treasury_bp',treasury],['industry_aaa_minus_treasury_bp',spread]]){
      const change=value-model.anchor_reference[name];
      result.values[model.feature_names.indexOf(name)]+=change;result.expected-=change;
    }
  }
  return result;
}

export function validateMLP(model) {
  const m=model.mlp,n=model.feature_names.length;
  const vector=(x,length,positive=false)=>Array.isArray(x)&&x.length===length&&x.every(v=>Number.isFinite(v)&&(!positive||v>0));
  if(!m||model.candidate.kind!=='mlp'||model.candidate.target!=='coupon'||model.candidate.feature_set!=='quote_history'
    ||model.linear||model.trees||model.market_layer||m.settings?.activation!=='relu'
    ||!Array.isArray(m.coefs)||m.coefs.length!==2||!Array.isArray(m.intercepts)||m.intercepts.length!==2
    ||!vector(m.preprocessing?.fill,n)||!vector(m.preprocessing?.center,n)||!vector(m.preprocessing?.scale,n,true)
    ||JSON.stringify(m.preprocessing?.feature_names)!==JSON.stringify(model.feature_names)
    ||JSON.stringify(m.preprocessing?.numeric)!==JSON.stringify(model.numeric)
    ||JSON.stringify(m.preprocessing?.categories)!==JSON.stringify(model.categories)
    ||m.coefs[0]?.length!==n||!m.coefs[0].every(row=>vector(row,8))
    ||m.coefs[1]?.length!==8||!m.coefs[1].every(row=>vector(row,1))
    ||!vector(m.intercepts[0],8)||!vector(m.intercepts[1],1)
    ||!Number.isFinite(m.target_mean_bp)||!(Number.isFinite(m.target_scale_bp)&&m.target_scale_bp>0))throw new Error('Invalid frozen MLP parameters');
}

function mlpParts(m,vector) {
  const p=m.preprocessing,z=vector.map((x,i)=>((Number.isFinite(x)?x:p.fill[i])-p.center[i])/p.scale[i]);
  const delta=Array.from({length:8},(_,k)=>z.reduce((sum,x,j)=>sum+x*m.coefs[0][j][k],0));
  const hidden=delta.map((x,k)=>Math.max(0,x+m.intercepts[0][k]));
  const prediction=m.target_mean_bp+m.target_scale_bp*(m.intercepts[1][0]+hidden.reduce((sum,x,k)=>sum+x*m.coefs[1][k][0],0));
  return {z,delta,prediction};
}

function mlpExplanation(m,vector) {
  const {z,delta}=mlpParts(m,vector),start=m.intercepts[0];
  const fraction=delta.map((d,k)=>{
    const end=start[k]+d;
    if(start[k]>0&&end>0)return 1;
    if(start[k]<=0&&end>0)return end/d;
    if(start[k]>0&&end<=0)return -start[k]/d;
    return 0;
  });
  return {
    values:z.map((x,j)=>m.target_scale_bp*x*fraction.reduce((sum,f,k)=>sum+f*m.coefs[0][j][k]*m.coefs[1][k][0],0)),
    expected:m.target_mean_bp+m.target_scale_bp*(m.intercepts[1][0]+start.reduce((sum,b,k)=>sum+Math.max(0,b)*m.coefs[1][k][0],0)),
  };
}

// Each horizon is a direct, matured-label market fit; interpolate only within 0..90.
export function marketParts(model, vector) {
  const layer=model.market_layer,parts=new Map(),read=name=>vector[model.feature_names.indexOf(name)];
  if(!layer||layer.mode==='zero')return {parts,base:0,change:0};
  if(read('industry_aaa_available')!==1)throw new Error('Market change requires the same dated industry reference');
  const states=layer.states,tenor=read('tenor')/5,lead=read('lead_days');
  const x=[...states.map(read),...states.map(name=>read(name)==null?null:read(name)*tenor),tenor];
  const horizons=[0,7,14,30,60,90];let base=0;
  for(let k=1;k<horizons.length;k++){
    const h=horizons[k],previous=horizons[k-1],next=horizons[k+1]??h;
    const weight=Math.min(Math.max(0,Math.min(1,(lead-previous)/(h-previous))),next>h?Math.max(0,Math.min(1,(next-lead)/(next-h))):1);
    if(!weight||read('market_known_zero')===1)continue;
    const m=layer.models[String(h)],phi=m.trees?explain(m,x):null,values=phi?phi.values:x.map((v,i)=>((Number.isFinite(v)?v:m.fill[i])-m.center[i])/m.scale[i]*m.coefficients[i]);
    for(let i=0;i<states.length;i++)parts.set(states[i],(parts.get(states[i])??0)+weight*(values[i]+values[i+states.length]));
    base+=weight*((phi?phi.expected:m.intercept)+values.at(-1));
  }
  return {parts,base,change:base+[...parts.values()].reduce((a,b)=>a+b,0)};
}
