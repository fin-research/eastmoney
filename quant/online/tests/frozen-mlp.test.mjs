import test from 'node:test';
import assert from 'node:assert/strict';
import { couponPrediction, couponExplanation, validateMLP } from '../coupon-model.mjs';
import {validateModel} from '../issuance.mjs';
import industryProfile from '../industry-source.json' with {type:'json'};

function model() {
  const preprocessing={fill:[2,-1],center:[2,-1],scale:[2,1],feature_names:['x','y'],numeric:['x','y'],categories:{}};
  return {candidate:{kind:'mlp',target:'coupon',feature_set:'quote_history'},feature_names:['x','y'],numeric:['x','y'],categories:{},mlp:{
    settings:{activation:'relu'},preprocessing,target_mean_bp:200,target_scale_bp:3,
    coefs:[[[1,-1,2,-2,0,1,1,0],[1,1,-1,-1,0,-1,1,0]],[[1],[-2],[0.5],[1],[2],[-1],[3],[0]]],
    intercepts:[[-1,1,0,2,0,-2,1,4],[0.25]],
  }};
}

test('frozen MLP predicts with missing inputs and sums exact path attribution',()=>{
  const m=model();validateMLP(m);
  for(const vector of [[null,null],[6,1],[-2,-5],[2,-1],[2+2e-12,-1]]){
    const phi=couponExplanation(m,vector,0),prediction=couponPrediction(m,vector,0);
    assert.ok(Math.abs(phi.expected+phi.values.reduce((a,b)=>a+b,0)-prediction)<1e-10);
    const z=vector.map((x,i)=>((x??m.mlp.preprocessing.fill[i])-m.mlp.preprocessing.center[i])/m.mlp.preprocessing.scale[i]);
    const hidden=m.mlp.intercepts[0].map((b,k)=>Math.max(0,b+z.reduce((s,x,j)=>s+x*m.mlp.coefs[0][j][k],0)));
    const independent=200+3*(0.25+hidden.reduce((s,x,k)=>s+x*m.mlp.coefs[1][k][0],0));
    assert.equal(prediction,independent);
  }
  assert.deepEqual(couponExplanation(m,[2,-1],0).values,[0,0]);
});

test('invalid MLP dimensions, scales, category order and model kind fail',()=>{
  for(const mutate of [m=>m.mlp.coefs[0].pop(),m=>m.mlp.preprocessing.scale[0]=0,m=>m.mlp.coefs[1][0][0]=Infinity,m=>m.candidate.kind='ridge',m=>m.mlp.preprocessing.numeric=['y','x']]){
    const m=structuredClone(model());mutate(m);assert.throws(()=>validateMLP(m),/Invalid frozen MLP/);
  }
});

test('MLP requires the fixed training boundary and empty savings contract',()=>{
  const m=model();m.feature_version='issuance-coupon';
  m.audit={training_as_of:'2026-01-01',training_label_cutoff:'2026-01-01',training_label_end:'2025-12-23'};
  Object.assign(m.mlp,{training_cutoff:'2026-01-01',training_label_end:'2025-12-23'});
  const manifest={feature_version:'issuance-coupon',feature_names:m.feature_names,required_input_groups:['industry_nodes'],industry_source_profile:industryProfile,
    training_label_cutoff:'2026-01-01',training_as_of:'2026-01-01',forecast_horizons:[1,14,30],expected_savings_supported:false};
  validateModel(manifest,m);
  for(const mutate of [a=>delete a.training_label_cutoff,a=>a.training_as_of='2026-10-26',a=>a.expected_savings_supported=true,a=>a.forecast_horizons=[1,30]]){
    const a=structuredClone(manifest);mutate(a);assert.throws(()=>validateModel(a,m),/cutoff or three-horizon/);
  }
  for(const mutate of [a=>a.mlp.training_cutoff='2026-02-01',a=>a.audit.training_label_end='2026-01-01',a=>delete a.audit.training_label_cutoff]){
    const a=structuredClone(m);mutate(a);assert.throws(()=>validateModel(manifest,a),/cutoff or three-horizon/);
  }
});
