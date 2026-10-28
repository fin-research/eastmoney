import{expect,it}from'vitest';import{curveMatrixDigest,curveRowDigest}from'../src/sync/broker-curve-grid-hash.ts';
const row={curve_code:'x',curve_name:'证券曲线',date:'2019-01-02',tenor_years:1,yield_pct:2,node_label:'1y'};
it('frames every text field and distinguishes null, empty, signed zero and adjacent float values',()=>{
 const a=curveRowDigest(row).toString('hex');
 for(const patch of [{curve_name:'证券曲线 '},{node_label:''},{node_label:null as never},{yield_pct:-0},{yield_pct:0},{yield_pct:2.0000000000000004}])
  expect(curveRowDigest({...row,...patch}).toString('hex')).not.toBe(a);
 expect(curveRowDigest({...row,yield_pct:-0})).not.toEqual(curveRowDigest({...row,yield_pct:0}));
 expect(curveRowDigest({...row,curve_code:'ab',curve_name:'c'})).not.toEqual(curveRowDigest({...row,curve_code:'a',curve_name:'bc'}));
});
it('hashes all ordered row digests and rejects duplicate or unsorted keys',()=>{
 const next={...row,date:'2019-01-03'};
 expect(curveMatrixDigest([row,next])).not.toBe(curveMatrixDigest([row]));
 expect(()=>curveMatrixDigest([next,row])).toThrow('Unsorted');expect(()=>curveMatrixDigest([row,row])).toThrow('duplicate');
});
