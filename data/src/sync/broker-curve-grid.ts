import { BROKER_CURVE_PROFILE, type StoredNode } from './broker-curve-history.ts';
import type { DatabaseClient } from './postgres.ts';

export const DENSE_GRID_TENORS = [...new Set([0.019178,0.038356,0.083333,0.166667,0.25,0.75,
  ...Array.from({length:100},(_,i)=>(i+1)/10)])].sort((a,b)=>a-b);
export const curveNodeKey = (row: Pick<StoredNode,'date'|'tenor_years'>) => `${row.date}/${row.tenor_years}`;
export function parseDenseCurveDay(raw: unknown, date: string): StoredNode[] {
  if(!Array.isArray(raw)||raw.length!==1)throw Error('Missing source curve');
  const s=raw[0];
  if(s.ycDefId!==BROKER_CURVE_PROFILE.curveCode||s.ycDefName!==`${BROKER_CURVE_PROFILE.curveName}(到期)`
    ||s.worktime!==date||!Array.isArray(s.seriesData))throw Error('Wrong source identity/date');
  const values=new Map<number,number>();
  for(const pair of s.seriesData){
    if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='number'||typeof pair[1]!=='number'
      ||!Number.isFinite(pair[1])||pair[1]<=0||pair[1]>=20||values.has(pair[0])
      ||(pair[0]!==0&&!DENSE_GRID_TENORS.includes(pair[0])))throw Error('Invalid/duplicate source grid');
    values.set(pair[0],pair[1]);
  }
  if(values.size!==107||!values.has(0)||DENSE_GRID_TENORS.some(t=>!values.has(t)))throw Error('Incomplete source grid');
  return DENSE_GRID_TENORS.map(tenor=>({curve_code:BROKER_CURVE_PROFILE.curveCode,curve_name:BROKER_CURVE_PROFILE.curveName,
    date,tenor_years:tenor,yield_pct:values.get(tenor)!,node_label:`${tenor}y`}));
}
export function planDenseCurveGrid(incoming: StoredNode[], before: StoredNode[]) {
  const old=new Map(before.map(r=>[curveNodeKey(r),r]));
  if(old.size!==before.length)throw Error('Duplicate before key');
  const seen=new Set<string>(),inserts:StoredNode[]=[],differences: Array<{date:string;tenor_years:number;stored:number;source:number}>=[];
  for(const row of incoming){
    const key=curveNodeKey(row);if(seen.has(key))throw Error('Duplicate incoming key');seen.add(key);
    const existing=old.get(key);
    if(!existing)inserts.push(row);
    else {
      if(existing.curve_code!==row.curve_code||existing.curve_name!==row.curve_name)throw Error('Existing curve identity differs');
      if(existing.yield_pct!==row.yield_pct)differences.push({date:row.date,tenor_years:row.tenor_years,stored:existing.yield_pct,source:row.yield_pct});
    }
  }
  if(before.some(r=>!seen.has(curveNodeKey(r))))throw Error('Existing key absent from source grid');
  return {inserts,retained:before,differences};
}
export async function applyDenseCurveGrid(db: DatabaseClient,plan: ReturnType<typeof planDenseCurveGrid>) {
  await db.query('BEGIN');
  try {
    await db.query('LOCK TABLE public.bond_industry_curve IN SHARE ROW EXCLUSIVE MODE');
    const current=await db.query<StoredNode>(`SELECT curve_code,curve_name,observation_date::text date,tenor_years,yield_pct,node_label
      FROM public.bond_industry_curve WHERE curve_code=$1 ORDER BY observation_date,tenor_years`,[BROKER_CURVE_PROFILE.curveCode]);
    if(JSON.stringify(current.rows)!==JSON.stringify(plan.retained))throw Error('Curve before-image changed');
    let inserted=0;
    for(let offset=0;offset<plan.inserts.length;offset+=1000){
      const rows=plan.inserts.slice(offset,offset+1000);
      const result=await db.query(`INSERT INTO public.bond_industry_curve
        (curve_code,curve_name,observation_date,tenor_years,yield_pct,node_label)
        SELECT curve_code,curve_name,date,tenor_years,yield_pct,node_label FROM jsonb_to_recordset($1::jsonb)
        x(curve_code text,curve_name text,date date,tenor_years double precision,yield_pct double precision,node_label text)`,[JSON.stringify(rows)]);
      if(result.rowCount!==rows.length)throw Error('Grid insert count mismatch');inserted+=result.rowCount;
    }
    await db.query('COMMIT');return {inserted,retained:current.rows.length};
  }catch(error){await db.query('ROLLBACK');throw error;}
}
