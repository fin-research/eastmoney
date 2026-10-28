import test from 'node:test';
import assert from 'node:assert/strict';
import { infer, validateModel, lowRateDates, issuanceRequest } from '../issuance.mjs';
import { encodeCoupon } from '../coupon-model.mjs';
import industryProfile from '../industry-source.json' with { type: 'json' };

test('one model encodes public, private and unknown terms without excluding private bonds',()=>{
  const model={numeric:['tenor'],candidate:{kind:'lgb'},categories:{issuer:{A:0},rating:{AAA:0},bond_type:{ordinary:0},placement_type:{公募:0,私募:1}}};
  const base={issuer:'A',rating:'AAA',bond_type:'ordinary',tenor:3};
  assert.deepEqual(encodeCoupon(model,{...base,placement_type:'公募'}),[3,0,0,0,0]);
  assert.deepEqual(encodeCoupon(model,{...base,issuer:'new',placement_type:'私募'}),[3,-1,0,0,1]);
  assert.deepEqual(encodeCoupon(model,{...base,placement_type:'unknown'}),[3,0,0,0,-1]);
});

test('superseded bundles cannot silently run in the unified coupon runtime',()=>{
  assert.throws(()=>validateModel({feature_version:'issuance-lgb-v2'},{}),/Wrong issuance/);
  assert.throws(()=>validateModel({feature_version:'issuance-coupon',feature_names:['x']},{feature_version:'issuance-coupon',feature_names:['y']}),/Feature order/);
});

test('median and robust center artifacts cannot publish expected savings',()=>{
  for(const profile of [4,5]) {
    assert.throws(()=>validateModel(
      {feature_version:'issuance-coupon',feature_names:['x']},
      {feature_version:'issuance-coupon',feature_names:['x'],candidate:{kind:'lgb',profile}},
    ),/cannot publish expected coupon savings/);
  }
});

test('stale industry quote fails before feature construction and model loading',async()=>{
  const row={observation_date:'2026-09-23',field:'placeholder',value:1};
  const datasets=Object.fromEntries(['funding','issue'].map(group=>[group,[row]]));
  datasets.industry_curve=[{observation_date:'2026-09-23',yield_pct:1.62}];
  const manifest={feature_version:'issuance-coupon',training_as_of:'2026-09-01',retrain_after:'2026-09-30',market_model:'unified_coupon',window_days:30,
    terms:{tenor:3},issue_size_yi:30,required_input_groups:Object.keys(datasets),calendar:{year:2026,closures:[],makeup_workdays:[]}};
  await assert.rejects(infer(manifest,{as_of_date:'2026-09-25',datasets},()=>{throw new Error('must not load');}),/Stale market quote/);
});

test('lower quartile includes ties and joins adjacent executable dates',()=>{
  const rows=[['2026-09-18',2],['2026-09-21',2],['2026-09-22',3],['2026-09-23',4]].map(([date,coupon_percent])=>({date,coupon_percent}));
  assert.deepEqual(lowRateDates(rows),{dates:['2026-09-18','2026-09-21'],windows:[{start:'2026-09-18',end:'2026-09-21'}],lowest_date:'2026-09-18',action:'尽快发行'});
});

test('request changes terms and horizon without changing the frozen model manifest',()=>{
  const manifest={window_days:30,issue_size_yi:30,terms:{issuer:'A',tenor:3,rating:'AAA',bond_type:'证券公司债',placement_type:'公募'}};
  const before=JSON.stringify(manifest);
  const request=issuanceRequest(manifest,{window_days:90,issue_size_yi:10,terms:{issuer:'new',tenor:5,placement_type:'私募'}});
  assert.equal(request.days,90);assert.equal(request.size,10);assert.equal(request.terms.issuer,'new');assert.equal(request.terms.placement_type,'私募');
  assert.equal(JSON.stringify(manifest),before);
  assert.throws(()=>issuanceRequest(manifest,{window_days:91}),/Invalid window/);
  assert.throws(()=>issuanceRequest(manifest,{terms:{bond_type:'含权债'}}),/Unsupported/);
});

test('public-only bundles bind scope and reject private or unknown requests',()=>{
  const manifest={issuance_scope:'public_only',window_days:30,issue_size_yi:30,terms:{issuer:'A',rating:'AAA',tenor:3,bond_type:'证券公司债',placement_type:'公募'},feature_version:'issuance-coupon',feature_names:['tenor']};
  assert.equal(issuanceRequest(manifest).terms.placement_type,'公募');
  for(const placement_type of ['私募','未知'])assert.throws(()=>issuanceRequest(manifest,{terms:{placement_type}}),/confirmed public/);
  const model={feature_version:'issuance-coupon',feature_names:['tenor'],candidate:{kind:'ridge',feature_set:'legacy'},audit:{issuance_scope:'all'}};
  assert.throws(()=>validateModel(manifest,model),/scope mismatch/);
  model.audit.issuance_scope='public_only';validateModel(manifest,model);
});


test('linear coupon imputes NaN and infinite live features in predictions and contributions',async()=>{
  const {couponPrediction,couponExplanation}=await import('../coupon-model.mjs');
  const model={numeric:['a','b','c'],candidate:{kind:'ridge',target:'excess',feature_set:'legacy'},categories:{issuer:{},rating:{},bond_type:{},placement_type:{}},linear:{fill:[2,3,4],center:[0,0,0],scale:[1,1,1],coefficients:[1,2,3],intercept:5}};
  const vector=encodeCoupon(model,{a:NaN,b:Infinity,c:4});
  assert.deepEqual(vector,[null,null,4]);
  for(const missing of [[NaN,Infinity,4],vector]){
    assert.equal(couponPrediction(model,missing,200),225);
    const phi=couponExplanation(model,missing,200);
    assert.equal(phi.values.reduce((sum,x)=>sum+x,phi.expected),225);
  }
});

test('Huber publication requires explicit point semantics in manifest, audit and validation',()=>{
  const model={feature_version:'issuance-coupon',feature_names:[],candidate:{kind:'lgb',profile:5,feature_set:'combined'},audit:{issuance_scope:'public_only',estimand:'huber_center'}};
  const manifest={feature_version:'issuance-coupon',feature_names:[],required_input_groups:['industry_nodes'],industry_source_profile:industryProfile,issuance_scope:'public_only',estimand:'huber_center',expected_savings_supported:false,validation:{estimand:'huber_center',expected_savings_supported:false}};
  validateModel(manifest,model);
  for(const changed of [{...manifest,expected_savings_supported:true},{...manifest,estimand:'conditional_mean'},{...manifest,validation:{}}])assert.throws(()=>validateModel(changed,model),/cannot publish/);
});

test('legacy request features never access optional curve dynamics',async()=>{
  const {couponFeature}=await import('../coupon-features.mjs');
  const context={features:[{date:'2026-09-29',rate_gov_1y_level:1,rate_gov_3y_level:1.2,rate_gov_10y_level:1.6}],events:[],secondary:new Map(),industryNodes:new Map(),calendarSpec:{year:2026,closures:[],makeup_workdays:[]}};
  Object.defineProperty(context,'curveDynamics',{get(){throw new Error('legacy curve access');}});
  const feature=couponFeature(context,{origin:'2026-09-30',lead_days:7,tenor:3,issue_size:30,issuer:'A',rating:'AAA',bond_type:'证券公司债',placement_type:'公募'});
  assert.ok(!Object.keys(feature).some(name=>name.startsWith('sector_')));
});
