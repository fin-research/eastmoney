import{expect,it}from'vitest';import{PGlite}from'@electric-sql/pglite';
import{DENSE_GRID_TENORS,parseDenseCurveDay,planDenseCurveGrid,applyDenseCurveGrid}from'../src/sync/broker-curve-grid.ts';
import{BROKER_CURVE_PROFILE}from'../src/sync/broker-curve-history.ts';
const payload=(date='2019-01-02')=>[{ycDefId:BROKER_CURVE_PROFILE.curveCode,ycDefName:`${BROKER_CURVE_PROFILE.curveName}(到期)`,worktime:date,seriesData:[[0,2],...DENSE_GRID_TENORS.map(t=>[t,3])]}];
it('requires the complete official numeric grid and excludes its zero anchor',()=>{
 expect(DENSE_GRID_TENORS).toHaveLength(106);expect(parseDenseCurveDay(payload(),'2019-01-02')).toHaveLength(106);
 const missing=payload();missing[0]!.seriesData.pop();expect(()=>parseDenseCurveDay(missing,'2019-01-02')).toThrow('Incomplete');
 const duplicate=payload();duplicate[0]!.seriesData.push([1,3]);expect(()=>parseDenseCurveDay(duplicate,'2019-01-02')).toThrow('duplicate');
 expect(()=>parseDenseCurveDay(payload(),'2019-01-03')).toThrow('identity/date');
});
it('inserts only missing keys while retaining overlap values and reporting differences',()=>{
 const incoming=parseDenseCurveDay(payload(),'2019-01-02');const before=[{...incoming[0]!,yield_pct:3.0001,node_label:'retained-label'}];
 const plan=planDenseCurveGrid(incoming,before);expect(plan.inserts).toHaveLength(105);expect(plan.retained).toEqual(before);
 expect(plan.differences).toEqual([{date:'2019-01-02',tenor_years:incoming[0]!.tenor_years,stored:3.0001,source:3}]);
 expect(()=>planDenseCurveGrid([...incoming,incoming[0]!],before)).toThrow('Duplicate');
});
it('locks and checks the full before-image, inserts without updates, and rolls back changed state',async()=>{
 const db=new PGlite();await db.exec(`CREATE TABLE public.bond_industry_curve(curve_code text,curve_name text,observation_date date,tenor_years double precision,yield_pct double precision,node_label text,PRIMARY KEY(curve_code,observation_date,tenor_years));`);
 const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return{...r,rowCount:r.affectedRows};};
 try{
  const incoming=parseDenseCurveDay(payload(),'2019-01-02'),plan=planDenseCurveGrid(incoming,[]);
  await expect(applyDenseCurveGrid({query}as never,plan)).resolves.toEqual({inserted:106,retained:0});
  const before=(await query(`SELECT curve_code,curve_name,observation_date::text date,tenor_years,yield_pct,node_label FROM public.bond_industry_curve ORDER BY observation_date,tenor_years`)).rows;
  const next=parseDenseCurveDay(payload('2019-01-03'),'2019-01-03');const second=planDenseCurveGrid([...incoming,...next],before as never);
  await db.exec('UPDATE public.bond_industry_curve SET yield_pct=4 WHERE tenor_years=1');
  await expect(applyDenseCurveGrid({query}as never,second)).rejects.toThrow('before-image changed');
  expect((await db.query('SELECT count(*)::int n FROM public.bond_industry_curve')).rows).toEqual([{n:106}]);
 }finally{await db.close();}
});
