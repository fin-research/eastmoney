// Lossless transport of one curve; observations remain in their original order.
export const CURVE_GRID_SQL = `SELECT json_build_object('encoding','curve-grid-v1',
  'curve_code',curve_code,'curve_name',curve_name,
  'rows',json_agg(json_build_array(observation_date::text,tenor_years,yield_pct)
    ORDER BY observation_date,tenor_years))::text AS payload
  FROM public.bond_industry_curve WHERE observation_date<$1::date
  GROUP BY curve_code,curve_name ORDER BY curve_code,curve_name`;
export function decodeCurveGrid(value) {
  if(Array.isArray(value))return value;
  if(value?.encoding!=='curve-grid-v1'
    ||value.curve_code!=='5781a1ff7651967e0176978d957b7346'
    ||value.curve_name!=='中债证券公司债收益率曲线(AAA)'
    ||!Array.isArray(value.rows)||!value.rows.length)throw Error('Invalid curve grid transport');
  let previousDate='',previousTenor=0;
  return value.rows.map(row=>{
    if(!Array.isArray(row)||row.length!==3)throw Error('Invalid curve grid row');
    const [date,tenor,yieldPct]=row;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)
      ||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date
      ||typeof tenor!=='number'||!Number.isFinite(tenor)||tenor<=0
      ||(yieldPct!==null&&(typeof yieldPct!=='number'||!Number.isFinite(yieldPct)))
      ||date<previousDate||(date===previousDate&&tenor<=previousTenor))throw Error('Invalid or unordered curve grid row');
    previousDate=date;previousTenor=tenor;
    return {curve_code:value.curve_code,curve_name:value.curve_name,observation_date:date,tenor_years:tenor,yield_pct:yieldPct};
  });
}
export function decodeCurveInputs(inputs) {
  const nodes=inputs.datasets.industry_nodes;
  return nodes===undefined||Array.isArray(nodes)?inputs:
    {...inputs,datasets:{...inputs.datasets,industry_nodes:decodeCurveGrid(nodes)}};
}
