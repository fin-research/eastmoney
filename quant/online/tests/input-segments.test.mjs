import test from 'node:test';
import assert from 'node:assert/strict';
import { scanInputSegment } from '../input-segments.mjs';
import { projectInputRows, validateRawQuoteDependencies } from '../raw-quote-context.mjs';

const grid={encoding:'curve-grid-v1',curve_code:'5781a1ff7651967e0176978d957b7346',curve_name:'中债证券公司债收益率曲线(AAA)',rows:[['2026-10-22',1,null],['2026-10-22',3,1.5],['2026-10-23',3,1.4]]};
test('segmented JSON preserves UTF-8, escapes, nested rows and every dataset at byte boundaries',()=>{
  const source={as_of_date:'2026-10-26',note:'中文💡\\"{}[]',datasets:{funding:[{observation_date:'2026-10-23',value:null,nested:{quoted:'a\\"b'}}],empty:[],industry_nodes:grid,issuer_daily:[{issuer:'东方财富',value:0}]}};
  const bytes=Buffer.from(JSON.stringify(source));
  for(const width of [1,2,3,7,31,128,32768]){
    let state;const datasets={};
    for(let offset=0;offset<bytes.length;offset+=width){
      const out=scanInputSegment(state,bytes.subarray(offset,offset+width),offset+width>=bytes.length);
      state=JSON.parse(JSON.stringify(out.state));
      for(const {group,row}of out.rows)(datasets[group]??=[]).push(row);
    }
    assert.deepEqual(state.meta,{as_of_date:source.as_of_date,note:source.note});
    for(const [name,rows]of Object.entries(source.datasets))assert.deepEqual(datasets[name]??[],Array.isArray(rows)?rows:rows.rows);
    assert.equal(state.phase,'done');
  }
  assert.throws(()=>scanInputSegment(undefined,bytes.subarray(0,-1),true),/Truncated/);
  assert.throws(()=>scanInputSegment(undefined,Buffer.concat([bytes,Buffer.from('junk')]),true),/suffix/);
});

test('projection validates the full grid across checkpoints and preserves quote missingness',()=>{
  const first=projectInputRows([{group:'industry_nodes',row:grid.rows[0],grid}], '2026-10-26',{});
  assert.deepEqual(first.datasets.industry_nodes,[grid.rows[0]]);
  const next=projectInputRows([{group:'industry_nodes',row:grid.rows[1],grid}], '2026-10-26',{},JSON.parse(JSON.stringify(first.state)));
  assert.deepEqual(next.datasets.industry_nodes,[grid.rows[1]]);
  assert.throws(()=>projectInputRows([{group:'industry_nodes',row:grid.rows[0],grid}], '2026-10-26',{},next.state),/order/);
  assert.throws(()=>projectInputRows([{group:'funding',row:{observation_date:'2026-10-26'}}], '2026-10-26',{}),/Unavailable/);
  assert.deepEqual(projectInputRows([{group:'industry_nodes',row:{curve_code:'other',observation_date:'2026-10-23',tenor_years:3,yield_pct:9}}], '2026-10-26',{}).datasets,{});
});

test('raw quote projection refuses an unimplemented model dependency',()=>{
  const model={candidate:{kind:'mlp',feature_set:'quote_history',target:'coupon'},numeric:['tenor','quote_h14','quote_h14_sector_quote_lag_19_bp']};
  validateRawQuoteDependencies(model);
  for(const name of ['weighted_cost','sector_quote_lag_20_bp','lead_days'])assert.throws(()=>validateRawQuoteDependencies({...model,numeric:[name]}),/dependencies/);
});
