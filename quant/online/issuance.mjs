import { addDays, dayGap, calendar, validateIndustryProfile } from './issuance-features.mjs';
import { couponContext, couponFeature, couponInputs } from './coupon-features.mjs';
import { encodeCoupon, couponPrediction, couponExplanation, couponAnchor, marketParts, validateMLP } from './coupon-model.mjs';
export const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function validateModel(manifest,model) {
  if(manifest.feature_version!=='issuance-coupon'||model.feature_version!==manifest.feature_version)throw new Error('Wrong issuance model version');
  if(!['all','public_only'].includes(manifest.issuance_scope??'all')||(model.audit?.issuance_scope??'all')!==(manifest.issuance_scope??'all'))throw new Error('Issuance scope mismatch');
  if(JSON.stringify(model.feature_names)!==JSON.stringify(manifest.feature_names))throw new Error('Feature order mismatch');
  if(model.candidate.kind==='mlp'||model.mlp){
    validateMLP(model);
    const cutoff='2026-01-01';
    if(manifest.training_label_cutoff!==cutoff||manifest.training_as_of!==cutoff
      ||model.audit?.training_label_cutoff!==cutoff||model.audit?.training_as_of!==cutoff
      ||model.mlp.training_cutoff!==cutoff||!validDate(model.mlp.training_label_end)
      ||model.mlp.training_label_end>=cutoff||model.audit.training_label_end!==model.mlp.training_label_end
      ||manifest.expected_savings_supported!==false||JSON.stringify(manifest.forecast_horizons)!=='[1,14,30]')throw new Error('Frozen MLP training cutoff or three-horizon contract mismatch');
  }
  const estimand=model.candidate.kind==='lgb'&&model.candidate.profile===5?'huber_center':model.candidate.kind==='lgb'&&model.candidate.profile===4?'conditional_median':'conditional_mean';
  if(estimand!=='conditional_mean'&&(estimand!=='huber_center'||manifest.issuance_scope!=='public_only'||manifest.estimand!==estimand||model.audit?.estimand!==estimand||manifest.expected_savings_supported!==false||manifest.validation?.estimand!==estimand||manifest.validation?.expected_savings_supported!==false))throw new Error('Robust-center research cannot publish expected coupon savings');
  if(manifest.estimand!==undefined&&manifest.estimand!==estimand)throw new Error('Coupon estimand mismatch');
  if(['industry_tenor','combined','combined_no_issuer','industry_basis','quote_static','quote_history','quote_pca','quote_product'].includes(model.candidate.feature_set)
    &&!manifest.required_input_groups.includes('industry_nodes'))throw new Error('Missing industry node requirement');
  if(manifest.required_input_groups?.some(name=>['industry_curve','industry_nodes'].includes(name)))validateIndustryProfile(manifest.industry_source_profile);
}
export function lowRateDates(rows) {
  if(!rows.length)return {dates:[],windows:[],lowest_date:null,action:'暂无预测'};
  const threshold=rows.map(r=>r.coupon_percent).sort((a,b)=>a-b)[Math.ceil(rows.length*.25)-1];
  const dates=rows.filter(r=>r.coupon_percent<=threshold).map(r=>r.date),windows=[];
  let previous=false;
  for(const row of rows){const selected=dates.includes(row.date);if(selected){if(previous)windows.at(-1).end=row.date;else windows.push({start:row.date,end:row.date});}previous=selected;}
  return {dates,windows,lowest_date:rows.reduce((a,b)=>a.coupon_percent<=b.coupon_percent?a:b).date,action:dates.includes(rows[0].date)?'尽快发行':'等待'};
}
export function issuanceRequest(manifest, request={}) {
  const terms={...manifest.terms};
  for(const key of ['issuer','rating','bond_type','placement_type','tenor']) {
    if(request.terms?.[key]!==undefined) terms[key]=request.terms[key];
  }
  const days=request.window_days??manifest.window_days,size=request.issue_size_yi??manifest.issue_size_yi;
  if(![30,60,90].includes(days)||!Number.isFinite(terms.tenor)||terms.tenor<1||terms.tenor>10||!Number.isFinite(size)||size<=0)throw new Error('Invalid window or terms');
  for(const [key,value] of Object.entries(request.terms??{})) {
    if(key!=='tenor'&&(typeof value!=='string'||!value.trim()))throw new Error('Invalid requested terms');
  }
  if(request.terms?.bond_type!==undefined&&!['证券公司债','证券公司次级债'].includes(terms.bond_type))throw new Error('Unsupported bond structure');
  if(manifest.issuance_scope==='public_only'&&terms.placement_type!=='公募')throw new Error('Public-only model requires confirmed public placement');
  return {days,terms,size};
}
export async function infer(manifest,inputs,loadModel,request={}) {
  inputs=couponInputs(inputs,manifest.issuance_scope??'all');
  if(manifest.training_label_cutoff)inputs={...inputs,training_label_cutoff:manifest.training_label_cutoff};
  const date=inputs.as_of_date,{days,terms,size}=issuanceRequest(manifest,request);
  if(!validDate(date)||date<manifest.training_as_of||date>manifest.retrain_after||manifest.market_model!=='unified_coupon')throw new Error('Invalid or expired issuance bundle');
  if(![30,60,90].includes(days)||!(terms.tenor>=1&&terms.tenor<=10)||!(Number.isFinite(size)&&size>0))throw new Error('Invalid window or terms');
  for(const group of manifest.required_input_groups){const rows=inputs.datasets[group];if(!rows?.length||rows.some(r=>r.observation_date>=date||(r.published_date??'')>=date))throw new Error(`Unavailable ${group} inputs`);}
  const cal=calendar(manifest.calendar);
  if(inputs.datasets.industry_curve&&!inputs.datasets.industry_curve.some(r=>r.observation_date===cal.previous(date)&&Number.isFinite(Number(r.yield_pct))))throw new Error('Stale market quote');
  const model=await loadModel('main');validateModel(manifest,model);
  const short=['quote_static','quote_history','quote_pca','quote_product'].includes(model.candidate.feature_set);
  if(short&&days!==30)throw new Error('Short coupon forecast requires a 30-day window');
  const point=manifest.expected_savings_supported===false;
  const context=couponContext(inputs,inputs.issuance_scope??'all',manifest.calendar,['tenor','tenor_shape'].includes(model.market_layer?.mode),short),source=context.quotes.at(-1).date;
  return inferContext(manifest,date,model,context,request);
}
export function inferContext(manifest,date,model,context,request={}) {
  const {days,terms,size}=issuanceRequest(manifest,request),cal=calendar(manifest.calendar);
  const short=['quote_static','quote_history','quote_pca','quote_product'].includes(model.candidate.feature_set),point=manifest.expected_savings_supported===false,source=context.quotes.at(-1).date;
  validateModel(manifest,model);
  if(!validDate(date)||date<manifest.training_as_of||date>manifest.retrain_after||manifest.market_model!=='unified_coupon')throw new Error('Invalid or expired issuance bundle');
  if(short&&days!==30)throw new Error('Short coupon forecast requires a 30-day window');
  if(source!==cal.previous(date))throw new Error('Stale market quote');
  const dates=Array.from({length:days+1},(_,i)=>addDays(date,i));
  const features=[];
  const forecast=(short?[1,14,30].map(h=>addDays(date,h)):dates.filter(cal.issuance)).map(target=>{
    const lead=dayGap(target,date),f=couponFeature(context,{...terms,origin:date,lead_days:lead,issue_size:size});
    features.push(f);
    const prediction=couponPrediction(model,encodeCoupon(model,f),f.known_treasury_bp);
    if(!(Number.isFinite(prediction)&&prediction>0))throw new Error('Invalid predicted coupon');
    return {date:target,lead_days:lead,forecast_origin:date,effective_horizon:lead,coupon_percent:prediction/100,
      coupon_low_percent:null,coupon_high_percent:null,market_change_bp:marketParts(model,encodeCoupon(model,f)).change,market_volatility_bp:null,market_level_percent:f.known_treasury_bp/100,
      market_source_date:source,market_train_label_end:model.audit.training_label_end,market_training_samples:model.audit.events,
      primary_history_latest_date:null,calibration_latest_label:null,status:['rating','bond_type','placement_type'].every(name=>Object.hasOwn(model.categories[name],f[name]))?'estimated':'coverage_limited',interval_samples:0,
      own_observations:f.issuer_observations,peer_observations:f.peer_observations,issuer_premium_bp:null,waiting_cost_bp:0,
      saving_probability:null,saving_p10_bp:null,pair_samples:null};
  });
  for(const row of forecast){const saving=(forecast[0].coupon_percent-row.coupon_percent)*100;Object.assign(row,{expected_saving_bp:point?null:saving,net_saving_bp:point?null:saving,annual_saving_wan:point?null:saving*size});}
  const low=short?{dates:[],windows:[],lowest_date:null,action:'仅预测票面'}:lowRateDates(forecast);
  const best=forecast.find(r=>r.date===low.lowest_date);
  const decision={action:low.action,reason:short?'coupon_prediction_only':'lowest_quartile',scope:short?'three horizon coupon predictions; no manual market signal rules':point?'Huber robust coupon point forecast; not expected financing cost':'predicted coupon only',validation_status:'historical conditional coupon forecasts',
    first_issuance_date:short?null:forecast[0]?.date??null,lowest_expected_cost_date:low.lowest_date,low_rate_dates:low.dates,low_rate_windows:low.windows,
    expected_net_saving_bp:best?.net_saving_bp??null,annual_saving_wan:best?.annual_saving_wan??null,saving_probability:null,saving_p10_bp:null,joint_error_pairs:null};
  let explanation=null,product_scenarios=[];
  if(forecast.length){
    const f=features[0],vector=encodeCoupon(model,f),phi=couponExplanation(model,vector,f.known_treasury_bp);
    explanation={method:model.market_layer?'additive_market_coupon':model.candidate.kind==='lgb'?'tree_path_dependent':model.candidate.kind==='mlp'?'relu_path_integrated_gradients':'linear',unit:'bp',base_coupon_bp:phi.expected,
      prediction_coupon_bp:forecast[0].coupon_percent*100,market_anchor_bp:couponAnchor(model,vector,f.known_treasury_bp),
      issuer_premium_bp:0,horizon_drift_bp:0,tree_expected_change_bp:0,
      features:model.feature_names.map((feature,i)=>({feature,value:vector[i],shap_bp:phi.values[i]}))};
    product_scenarios=[[3,'证券公司债'],[5,'证券公司债'],[3,'证券公司次级债'],[5,'证券公司次级债']].map(([tenor,bond_type])=>{
      const f=couponFeature(context,{...terms,tenor,bond_type,origin:date,lead_days:forecast[0].lead_days,issue_size:size});
      return {tenor,bond_type,coupon_percent:couponPrediction(model,encodeCoupon(model,f),f.known_treasury_bp)/100,own_observations:f.issuer_observations,peer_observations:f.peer_observations};
    });
  }
  const market_forecast=dates.map(target=>({date:target,market_level_percent:Number(context.quotes.at(-1).GOV_3Y),quote_day:cal.quote(target),issuance_day:cal.issuance(target),value_date:source,status:'known reference, not a separate forecast'}));
  return {schema_version:'issuance-forecast-v1',run_id:crypto.randomUUID(),generated_at:new Date().toISOString(),as_of_date:date,
    deadline:dates.at(-1),window_days:days,market_source_date:source,market_model:'unified_coupon',terms,issue_size_yi:size,waiting_cost_bp_day:0,
    decision,forecast,market_forecast,product_scenarios,explanation,validation:manifest.validation,calendar_audit:{calendar:manifest.calendar},publication:'issuance-forecast',
    online_run:{runtime:'node',feature_version:manifest.feature_version,model_version:manifest.model_version,training_as_of:manifest.training_as_of,retrain_after:manifest.retrain_after}};
}
