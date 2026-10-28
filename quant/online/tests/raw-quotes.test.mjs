import test from 'node:test';
import assert from 'node:assert/strict';
import {rawQuote} from '../coupon-features.mjs';
import {validateModel} from '../issuance.mjs';
import industryProfile from '../industry-source.json' with { type: 'json' };

test('industry bundles bind the publication profile actually used by inference',()=>{
  const model={feature_version:'issuance-coupon',feature_names:[],candidate:{kind:'ridge',feature_set:'quote_history'},audit:{}};
  const manifest={feature_version:'issuance-coupon',feature_names:[],required_input_groups:['industry_nodes'],industry_source_profile:industryProfile};
  validateModel(manifest,model);
  for(const profile of [undefined,{...industryProfile,firstPublicationDate:'2019-01-01'}])assert.throws(()=>validateModel({...manifest,industry_source_profile:profile},model),/source profile/);
});

test('raw quotes retain missing fixed tenor nodes and complete missing days',()=>{
  assert.equal(rawQuote([{tenor:1,yield:1},{tenor:5,yield:2}],3),null);
  assert.equal(rawQuote([{tenor:3,yield:1.6}],3),160);
  assert.equal(rawQuote([{tenor:3,yield:1.6}],4),null);
  assert.equal(rawQuote([],3),null);
  assert.equal(rawQuote([{tenor:3,yield:1.6},{tenor:5,yield:2}],4),180);
});
