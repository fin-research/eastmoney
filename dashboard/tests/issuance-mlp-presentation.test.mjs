import assert from 'node:assert/strict';
import test from 'node:test';
import {groupMlpContributions, issuanceFeatureName} from '../src/lib/issuance-presentation.ts';
import {mlpExplanation} from './fixtures/issuance-mlp.mjs';

test('all 244 MLP columns reconcile without filtering null or zero encoded values', () => {
  const explanation=mlpExplanation();
  assert.equal(explanation.features.length,244);
  const grouped=groupMlpContributions(explanation.features);
  assert.deepEqual(new Set(grouped.map(row=>row.display_name)),new Set(['国债收益率','行业报价','发行人报价','发行人身份','信用评级','发行条款','预测提前期']));
  assert.ok(Math.abs(explanation.base_coupon_bp+grouped.reduce((sum,row)=>sum+row.net_bp,0)-explanation.prediction_coupon_bp)<1e-10);
  for(const value of [null,0]) assert.equal(groupMlpContributions([{feature:'sector_quote_lag_0_bp',value,shap_bp:2}])[0].net_bp,2);
  for(const row of explanation.features) assert.doesNotMatch(issuanceFeatureName(row.feature),/未登记/);
  assert.equal(issuanceFeatureName('quote_h14_issuer_quote_lag_3_bp'),'提前14日×发行人报价·前3个报价日');
});

test('unknown columns retain their identity and contribution', () => {
  const rows=[{feature:'future_source',value:null,shap_bp:4},{feature:'future_source',value:0,shap_bp:-1}];
  assert.deepEqual(groupMlpContributions(rows),[{display_name:'未登记列：future_source',net_bp:3,absolute_bp:3}]);
  assert.equal(issuanceFeatureName('future_source'),'未登记列：future_source');
});

test('a response without model eligibility is suspended by default', async () => {
  const {parseIssuanceReport}=await import('../src/lib/issuance-model.ts');
  const {financingModel}=await import('./visual/report-fixtures.mjs');
  const response=structuredClone(financingModel);delete response.model_status;
  assert.deepEqual(parseIssuanceReport(response).model_status,{model_version:null,status:'suspended',reason:'quality_review_required'});
});
