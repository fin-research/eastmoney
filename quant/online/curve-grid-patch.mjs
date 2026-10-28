// A transport-only patch of the separately deployed, reviewed production module.
import {CURVE_GRID_SQL,decodeCurveGrid,decodeCurveInputs} from './curve-grid.mjs';
export const OLD_GRID_BLOCK = `            const result2 = await client.query("SELECT coalesce(json_agg(t),'[]'::json)::text AS payload FROM (SELECT curve_code,curve_name,observation_date::text,tenor_years,yield_pct FROM public.bond_industry_curve WHERE observation_date<$1::date ORDER BY observation_date,tenor_years) t", [date]);
            const payload2 = result2.rows[0].payload;
            if (payload2.length > 16 * 1024 * 1024 || payload2 === "[]") throw new NonRetryableError("Invalid industry node inputs");
            datasets[group] = JSON.parse(payload2);`;
export const OLD_INPUT_READ = 'const inputs = await readJson(this.env.ARTIFACTS, `${runPrefix}/inputs.json`, 32 * 1024 * 1024);';
export function patchCurveGridRuntime(source) {
  for(const part of [OLD_GRID_BLOCK,OLD_INPUT_READ])if(source.split(part).length!==2)throw Error('Production transport source changed');
  if(source.includes('function decodeCurveGrid(')||source.includes('function decodeCurveInputs('))throw Error('Transport patch already present');
  const block=`            const result2 = await client.query(curveGridSql, [date]);
            if (result2.rows.length !== 1) throw new NonRetryableError("Invalid industry curve identity");
            const payload2 = result2.rows[0].payload;
            if (payload2.length > 16 * 1024 * 1024 || payload2 === "[]") throw new NonRetryableError("Invalid industry node inputs");
            const grid = JSON.parse(payload2);
            decodeCurveGrid(grid);
            datasets[group] = grid;`;
  return `const curveGridSql = ${JSON.stringify(CURVE_GRID_SQL)};\n${decodeCurveGrid.toString()}\n${decodeCurveInputs.toString()}\n`
    +source.replace(OLD_GRID_BLOCK,block).replace(OLD_INPUT_READ,`const inputs = decodeCurveInputs(await readJson(this.env.ARTIFACTS, \`\${runPrefix}/inputs.json\`, 32 * 1024 * 1024));`);
}
