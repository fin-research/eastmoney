import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCurveGrid,decodeCurveInputs} from '../curve-grid.mjs';
const fixture=()=>({encoding:'curve-grid-v1',curve_code:'5781a1ff7651967e0176978d957b7346',curve_name:'中债证券公司债收益率曲线(AAA)',rows:[['2026-10-21',0.1,null],['2026-10-21',3,1.2],['2026-10-22',3,1.1]]});
test('curve grid preserves every row, null and array input',()=>{
 const grid=fixture(),rows=decodeCurveGrid(grid);
 assert.deepEqual(rows,grid.rows.map(([date,tenor,yieldPct])=>({curve_code:grid.curve_code,curve_name:grid.curve_name,observation_date:date,tenor_years:tenor,yield_pct:yieldPct})));
 assert.equal(decodeCurveGrid(rows),rows);
 const inputs={datasets:{industry_nodes:grid,other:[1]}};
 assert.deepEqual(decodeCurveInputs(inputs),{datasets:{industry_nodes:rows,other:[1]}});
 assert.equal(inputs.datasets.industry_nodes,grid);
});
test('curve grid rejects changed identity, unknown encoding and malformed rows',()=>{
 for(const mutate of [g=>g.encoding='other',g=>g.curve_code='other',g=>g.curve_name='other',g=>g.rows=[],g=>g.rows[0][0]='2026-02-30',g=>g.rows[0][1]=0,g=>g.rows[0][2]=true,g=>g.rows[0].push(1),g=>g.rows[1]=g.rows[0],g=>g.rows.reverse()]){const g=fixture();mutate(g);assert.throws(()=>decodeCurveGrid(g));}
});
