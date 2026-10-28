/** Read-only complete-matrix binary digest verification; no upstream HTTP/Choice. */
import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import path from'node:path';import{Client}from'pg';
import{BROKER_CURVE_PROFILE,type StoredNode}from'../src/sync/broker-curve-history.ts';
import{curveMatrixDigest,curveRowDigest,curveRowDigestSql,CURVE_MATRIX_HASH_SQL}from'../src/sync/broker-curve-grid-hash.ts';
const[directory,reviewedSha]=process.argv.slice(2);if(!directory||!reviewedSha)throw Error('Usage: verify-broker-curve-grid-hash.ts DIR MANIFEST_SHA');
const hash=(b:string)=>createHash('sha256').update(b).digest('hex'),read=(file:string)=>readFile(path.join(directory,file),'utf8');
const manifestBytes=await read('manifest.json');if(hash(manifestBytes)!==reviewedSha)throw Error('Manifest changed');
const m=JSON.parse(manifestBytes),expectedBytes=await read('expected-rows.json'),beforeBytes=await read('before.json');
if(hash(expectedBytes)!==m.expectedRowsSha256||hash(beforeBytes)!==m.beforeSha256)throw Error('Reviewed rows changed');
const expected:StoredNode[]=JSON.parse(expectedBytes),before:StoredNode[]=JSON.parse(beforeBytes);
if(expected.length!==206170||before.length!==34489)throw Error('Unapproved matrix count');
const expectedHash=curveMatrixDigest(expected),beforeHash=curveMatrixDigest(before);
const vectors:StoredNode[]=[{curve_code:'a|b',curve_name:'证券\n曲线',date:'2019-01-02',tenor_years:1.0000000000000002,yield_pct:-0,node_label:null as never},
 {curve_code:'ab',curve_name:'证券\n曲线',date:'2019-01-03',tenor_years:1e-300,yield_pct:2.7388,node_label:''}];
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{
 await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const vectorRows=(await db.query(`WITH v(curve_code,curve_name,observation_date,tenor_years,yield_pct,node_label) AS
 (VALUES ('a|b'::text,E'证券\\n曲线'::text,'2019-01-02'::date,'1.0000000000000002'::float8,'-0'::float8,NULL::text),
 ('ab',E'证券\\n曲线','2019-01-03'::date,'1e-300'::float8,'2.7388'::float8,''))
 SELECT encode(${curveRowDigestSql('v')},'hex') hash FROM v ORDER BY observation_date,tenor_years`)).rows;
 if(vectorRows.some((r,i)=>r.hash!==curveRowDigest(vectors[i]!).toString('hex')))throw Error('Postgres/Node byte contract differs');
 const result=(await db.query(CURVE_MATRIX_HASH_SQL,[BROKER_CURVE_PROFILE.curveCode,JSON.stringify(before.map(r=>({date:r.date,tenor_years:r.tenor_years})))])).rows[0];
 await db.query('COMMIT');
 const verified=result.rows===206170&&result.unique_keys===206170&&result.dates===1945&&result.hash===expectedHash
  &&result.retained_rows===34489&&result.retained_hash===beforeHash;
 const receipt={verifiedAt:new Date().toISOString(),method:'complete ordered six-field binary SHA256 matrix and retained-key subset',
  byteContract:'field order curve_code,curve_name,ISO date,tenor,yield,node_label; uint32BE byte-length prefix,ffffffff NULL; UTF8 text; float8 IEEE754BE; SHA256 each row, concatenate binary row digests ordered date/tenor, SHA256',
  manifestSha256:reviewedSha,expectedFileSha256:hash(expectedBytes),beforeFileSha256:hash(beforeBytes),expectedHash,beforeHash,
  byteContractVectors:vectorRows,actual:result,verified,fullRowsDownloaded:false,paidChoiceCalls:0};
 await writeFile(path.join(directory,'hash-verification.json'),JSON.stringify(receipt,null,2));console.log(receipt);
 if(!verified)throw Error('Full matrix hash verification failed');
}catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{await db.end();}
