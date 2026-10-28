import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {registeredInference} from '../prospective-infer.mjs';

function request(date='2026-10-03') {
  const model={feature_version:'issuance-coupon',feature_names:[],candidate:{kind:'ridge',feature_set:'legacy'},audit:{issuance_scope:'all'}};
  const manifest={feature_version:'issuance-coupon',feature_names:[],issuance_scope:'all',market_model:'unified_coupon',
    training_as_of:'2026-10-01',retrain_after:'2026-10-31',required_input_groups:[],
    calendar:{year:2026,closures:[],makeup_workdays:[]},terms:{issuer:'synthetic',tenor:3,rating:'AAA',bond_type:'证券公司债',placement_type:'公募'},window_days:30,issue_size_yi:1};
  return {manifest,model,inputs:{as_of_date:date,datasets:{}},request:{}};
}
test('registration inference retains expiry, scope and feature validation',async()=>{
  const expired=request();expired.manifest.retrain_after='2026-09-30';
  await assert.rejects(registeredInference(expired),/expired/);
  const wrong=request();wrong.model.feature_names=['changed'];
  await assert.rejects(registeredInference(wrong),/Feature order/);
  const mismatch=request();mismatch.model.audit.issuance_scope='public_only';
  await assert.rejects(registeredInference(mismatch),/scope mismatch/);
});
test('unknown calendar cannot be bypassed through the registry entry',async()=>{
  const unknown=request('2027-01-04');
  Object.assign(unknown.manifest,{training_as_of:'2027-01-01',retrain_after:'2027-01-31'});
  unknown.inputs.datasets.industry_curve=[{observation_date:'2026-12-31',yield_pct:2}];
  await assert.rejects(registeredInference(unknown),/Verified calendar year unavailable/);
});
test('stdout-only CLI rejects expired input without producing a result',()=>{
  const expired=request();expired.manifest.retrain_after='2026-09-30';
  const process=spawnSync(globalThis.process.execPath,[fileURLToPath(new URL('../prospective-infer.mjs',import.meta.url))],{input:JSON.stringify(expired),encoding:'utf8'});
  assert.equal(process.status,1);assert.equal(process.stdout,'');
  assert.equal(JSON.parse(process.stderr).code,'registration_inference_rejected');
});
