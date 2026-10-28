// Same complete-quote clock and exact 1/3/5/7/10Y nodes as the Python registry.
const tenors=[1,3,5,7,10],names=['change_1','change_5','change_20','deviation_20','deviation_60'];
const finite=x=>x!=null&&Number.isFinite(x);
export function curveDynamics(features,nodes){
  const levels=features.map(f=>tenors.map(t=>{
    const row=nodes.get(f.date)?.find(r=>r.tenor===t);return row?row.yield*100:null;
  }));
  return new Map(features.map((f,i)=>{
    const values=tenors.map((t,k)=>{
      const now=levels[i][k],out={};
      for(const lag of [1,5,20])out[`change_${lag}`]=i>=lag&&finite(now)&&finite(levels[i-lag][k])?now-levels[i-lag][k]:null;
      for(const w of [20,60]){
        const window=levels.slice(Math.max(0,i-w+1),i+1).map(r=>r[k]);
        out[`deviation_${w}`]=window.length===w&&window.every(finite)?now-window.reduce((a,b)=>a+b,0)/w:null;
      }
      return out;
    });
    const [a,b,,,e]=levels[i];
    return [f.date,{values,slope:finite(a)&&finite(e)?e-a:null,curvature:[a,b,e].every(finite)?b-(7*a+2*e)/9:null}];
  }));
}
export function curveFeature(state,tenor){
  const out={sector_slope_10_1:state?.slope??null,sector_curvature_3:state?.curvature??null};
  let right=tenors.findIndex(t=>t>=tenor);const left=Math.max(0,right-1);
  for(const name of names){
    let value=null;
    if(state&&tenor>=1&&tenor<=10&&right>=0){
      const a=state.values[left][name],b=state.values[right][name];
      const w=right===left?0:(tenor-tenors[left])/(tenors[right]-tenors[left]);
      value=w===1?b:w===0?a:finite(a)&&finite(b)?a+w*(b-a):null;
    }
    out[`sector_tenor_${name}`]=value;
  }
  return out;
}
