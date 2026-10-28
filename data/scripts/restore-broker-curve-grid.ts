/** Offline-only insertion of captured official curve grid nodes. No upstream HTTP or Choice calls. */
import{readFile,writeFile,mkdir}from'node:fs/promises';import{createHash}from'node:crypto';import path from'node:path';import{Client}from'pg';
import{BROKER_CURVE_PROFILE,type StoredNode}from'../src/sync/broker-curve-history.ts';
import{parseDenseCurveDay,planDenseCurveGrid,applyDenseCurveGrid,curveNodeKey}from'../src/sync/broker-curve-grid.ts';
const [mode,directory,sourceOrSha,rowsSha]=process.argv.slice(2);
if(!['prepare','apply','verify'].includes(mode??'')||!directory||!sourceOrSha||(mode==='apply'&&!rowsSha))
 throw Error('Usage: restore-broker-curve-grid.ts prepare DIR SOURCE_DIR | apply DIR MANIFEST_SHA ROWS_SHA | verify DIR MANIFEST_SHA');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const read=(file:string)=>readFile(path.join(directory,file),'utf8');
async function collect(source:string,dates:string[]){
 if(dates.length!==1945||new Set(dates).size!==1945||dates[0]!=='2019-01-02'||dates.at(-1)!=='2026-10-22')throw Error('Unapproved date matrix');
 const nodes:StoredNode[]=[],sources:Array<{date:string;file:string;sha256:string;rawSha256:string;capturedAt:string}>=[];
 for(const date of dates){
  const file=path.resolve(source,'daily',`${date}.json`),bytes=await readFile(file,'utf8'),s=JSON.parse(bytes);
  if(s.status!==200||s.parameters?.workTimes!==date||s.parameters?.ycDefIds!==BROKER_CURVE_PROFILE.curveCode
    ||typeof s.rawBody!=='string'||!Number.isFinite(Date.parse(s.capturedAt)))throw Error('Unverified captured source');
  nodes.push(...parseDenseCurveDay(JSON.parse(s.rawBody),date));sources.push({date,file,sha256:hash(bytes),rawSha256:hash(s.rawBody),capturedAt:s.capturedAt});
 }
 return{nodes,sources};
}
if(mode==='prepare'){
 await mkdir(directory,{recursive:true});
 try{await read('manifest.json');throw Error('Manifest already exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const dates:string[]=JSON.parse(await readFile(path.join(sourceOrSha!,'dates.json'),'utf8'));
 const beforeBytes=await readFile(path.join(sourceOrSha!,'closure-current-rows.json'),'utf8'),before:StoredNode[]=JSON.parse(beforeBytes);
 const{nodes,sources}=await collect(sourceOrSha!,dates);const plan=planDenseCurveGrid(nodes,before);
 if(before.length!==34489||nodes.length!==206170||plan.inserts.length!==171681||plan.differences.length!==401)throw Error('Unapproved plan counts');
 const expected=[...before,...plan.inserts].sort((a,b)=>a.date.localeCompare(b.date)||a.tenor_years-b.tenor_years);
 await writeFile(path.join(directory,'before.json'),beforeBytes);await writeFile(path.join(directory,'dates.json'),JSON.stringify(dates));
 const insertBytes=JSON.stringify(plan.inserts),expectedBytes=JSON.stringify(expected);
 await writeFile(path.join(directory,'insert-rows.json'),insertBytes);await writeFile(path.join(directory,'expected-rows.json'),expectedBytes);
 await writeFile(path.join(directory,'retained-differences.json'),JSON.stringify(plan.differences));
 const manifest={createdAt:new Date().toISOString(),profile:BROKER_CURVE_PROFILE,sourceDirectory:path.resolve(sourceOrSha!),
  meaning:'106 positive tenor nodes of one published curve per date; not independent bond observations',
  pointsAvailableAt:null,historicalVintageVerified:false,preLaunch:'retrospective_simulation',
  networkCalls:0,choiceCalls:0,paidPoints:0,dateCount:dates.length,sourceNodes:nodes.length,beforeRows:before.length,
  inserts:plan.inserts.length,retainedDifferences:plan.differences.length,zeroAnchorsExcluded:dates.length,
  beforeSha256:hash(beforeBytes),datesSha256:hash(JSON.stringify(dates)),insertRowsSha256:hash(insertBytes),expectedRowsSha256:hash(expectedBytes),sources};
 const bytes=JSON.stringify(manifest,null,2);await writeFile(path.join(directory,'manifest.json'),bytes);
 console.log(JSON.stringify({manifestSha256:hash(bytes),insertRowsSha256:hash(insertBytes),expectedRowsSha256:hash(expectedBytes),inserts:plan.inserts.length}));
}else{
 const manifestBytes=await read('manifest.json');if(hash(manifestBytes)!==sourceOrSha)throw Error('Reviewed manifest changed');
 const m=JSON.parse(manifestBytes),beforeBytes=await read('before.json'),dateBytes=await read('dates.json'),insertBytes=await read('insert-rows.json'),expectedBytes=await read('expected-rows.json');
 if(hash(beforeBytes)!==m.beforeSha256||hash(dateBytes)!==m.datesSha256||hash(insertBytes)!==m.insertRowsSha256
   ||hash(expectedBytes)!==m.expectedRowsSha256||(mode==='apply'&&hash(insertBytes)!==rowsSha))throw Error('Reviewed matrix changed');
 const dates=JSON.parse(dateBytes),before:StoredNode[]=JSON.parse(beforeBytes),{nodes,sources}=await collect(m.sourceDirectory,dates);
 if(JSON.stringify(sources)!==JSON.stringify(m.sources))throw Error('Captured source identity changed');
 const plan=planDenseCurveGrid(nodes,before);
 if(JSON.stringify(plan.inserts)!==insertBytes||plan.inserts.length!==171681||plan.retained.length!==34489)throw Error('Rebuilt matrix changed');
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
 try{
  if(mode==='apply'){
   const result=await applyDenseCurveGrid(db,plan);await writeFile(path.join(directory,'application.json'),JSON.stringify({appliedAt:new Date().toISOString(),manifestSha256:sourceOrSha,insertRowsSha256:rowsSha,...result},null,2));console.log(result);
  }else{
   await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const rows:StoredNode[]=[];
   try{
    await db.query(`DECLARE curve_verification NO SCROLL CURSOR FOR SELECT curve_code,curve_name,observation_date::text date,
      tenor_years,yield_pct,node_label FROM public.bond_industry_curve WHERE curve_code=$1 ORDER BY observation_date,tenor_years`,[BROKER_CURVE_PROFILE.curveCode]);
    while(true){
     const page=(await db.query<StoredNode>('FETCH FORWARD 5000 FROM curve_verification')).rows;
     if(!page.length)break;
     rows.push(...page);if(rows.length>206170)throw Error('Unexpected extra grid rows');
    }
    await db.query('CLOSE curve_verification');await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}
   const bytes=JSON.stringify(rows);await writeFile(path.join(directory,'after.json'),bytes);
   const expected:StoredNode[]=JSON.parse(expectedBytes),map=new Map(rows.map(r=>[curveNodeKey(r),r]));
   const changed=expected.filter(r=>JSON.stringify(map.get(curveNodeKey(r)))!==JSON.stringify(r)).length;
   const retainedChanged=before.filter(r=>JSON.stringify(map.get(curveNodeKey(r)))!==JSON.stringify(r)).length;
   const verification={verifiedAt:new Date().toISOString(),rows:rows.length,expectedRows:expected.length,changed,retainedChanged,
    afterSha256:hash(bytes),manifestSha256:sourceOrSha,dateCount:new Set(rows.map(r=>r.date)).size,first:rows[0]?.date,last:rows.at(-1)?.date};
   await writeFile(path.join(directory,'verification.json'),JSON.stringify(verification,null,2));console.log(verification);
   if(rows.length!==206170||changed||retainedChanged)throw Error('Post-commit grid verification failed');
  }
 }finally{await db.end();}
}
