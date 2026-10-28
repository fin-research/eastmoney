import{createHash}from'node:crypto';import type{StoredNode}from'./broker-curve-history.ts';
// Six fields in SELECT order. Every field is length-prefixed with an unsigned
// 32-bit big-endian byte count; ffffffff means NULL. Floats use IEEE754 binary64 BE.
function frame(value:string|number|null):Buffer{
 if(value===null)return Buffer.from('ffffffff','hex');
 const bytes=typeof value==='number'?Buffer.alloc(8):Buffer.from(value,'utf8');
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Nonfinite curve value');bytes.writeDoubleBE(value);}
 const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes]);
}
export function curveRowDigest(row:StoredNode):Buffer{
 return createHash('sha256').update(Buffer.concat([frame(row.curve_code),frame(row.curve_name),frame(row.date),
  frame(row.tenor_years),frame(row.yield_pct),frame(row.node_label??null)])).digest();
}
export function curveMatrixDigest(rows:StoredNode[]):string{
 const result=createHash('sha256');let previous:StoredNode|undefined;
 for(const row of rows){
  if(previous&&(row.date<previous.date||(row.date===previous.date&&row.tenor_years<=previous.tenor_years)))
   throw Error('Unsorted or duplicate curve key');
  result.update(curveRowDigest(row));previous=row;
 }
 return result.digest('hex');
}
function textFrame(sql:string){return `CASE WHEN ${sql} IS NULL THEN decode('ffffffff','hex') ELSE int4send(octet_length(convert_to(${sql},'UTF8')))||convert_to(${sql},'UTF8') END`;}
function floatFrame(sql:string){return `CASE WHEN ${sql} IS NULL THEN decode('ffffffff','hex') ELSE int4send(8)||float8send(${sql}) END`;}
export function curveRowDigestSql(alias:string){
 if(!/^[a-z]+$/.test(alias))throw Error('Invalid SQL alias');
 return `sha256(${[textFrame(`${alias}.curve_code`),textFrame(`${alias}.curve_name`),textFrame(`to_char(${alias}.observation_date,'YYYY-MM-DD')`),
  floatFrame(`${alias}.tenor_years`),floatFrame(`${alias}.yield_pct`),textFrame(`${alias}.node_label`)].map(x=>`(${x})`).join('||')})`;
}
export const CURVE_MATRIX_HASH_SQL=`WITH old AS (
 SELECT * FROM jsonb_to_recordset($2::jsonb) x(date date,tenor_years double precision)
), nodes AS (
 SELECT c.observation_date,c.tenor_years,${curveRowDigestSql('c')} row_hash,(old.date IS NOT NULL) retained
 FROM public.bond_industry_curve c LEFT JOIN old ON old.date=c.observation_date AND old.tenor_years=c.tenor_years
 WHERE c.curve_code=$1
) SELECT count(*)::int rows,count(DISTINCT observation_date)::int dates,
 count(DISTINCT(observation_date,tenor_years))::int unique_keys,
 min(observation_date)::text first,max(observation_date)::text last,
 encode(sha256(string_agg(row_hash,''::bytea ORDER BY observation_date,tenor_years)),'hex') hash,
 count(*) FILTER(WHERE retained)::int retained_rows,
 encode(sha256(string_agg(row_hash,''::bytea ORDER BY observation_date,tenor_years) FILTER(WHERE retained)),'hex') retained_hash
 FROM nodes`;
