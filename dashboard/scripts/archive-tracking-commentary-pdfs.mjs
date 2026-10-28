import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cloudflareClient } from './credit-cloudflare-client.mjs';
import { commentaryPdfKey, renderCommentaryPdf } from '../src/lib/research-commentary-pdf.ts';
const option = name => process.argv.find(value => value.startsWith(name+'='))?.slice(name.length+1);
const manifestPath = option('--manifest'), sourceDirectory = option('--source'), outputDirectory = option('--output');
if (!manifestPath || !sourceDirectory || !outputDirectory) throw new Error('Required: --manifest=... --source=... --output=... [--apply]');
const output = path.resolve(outputDirectory);
const root = path.resolve(new URL('../',import.meta.url).pathname);
if (output === root || output.startsWith(root+path.sep)) throw new Error('Archive artifacts must stay outside Git');
await mkdir(output,{recursive:true});
const apply = process.argv.includes('--apply'), request = await cloudflareClient();
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const databaseId = config.d1_databases.find(item=>item.binding==='DB')?.database_id;
async function query(sql,params=[]) {
  const response = await request(`/d1/database/${databaseId}/query`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql,params})});
  const result = await response.json();
  if (!result.success || result.result.some(item=>!item.success)) throw new Error('D1 archive operation failed');
  return result.result.flatMap(item=>item.results);
}
const rows = await query('SELECT * FROM commentary ORDER BY id');
const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
const byId = new Map(manifest.map(item=>[item.id,item]));
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const plan=[];
for (const row of rows) {
  const item = byId.get(row.id), sourceFile = item?.sourceFiles.find(file=>file.name.toLowerCase().endsWith('.pdf'));
  if (item && !sourceFile) throw new Error('Historical PDF missing: '+item.filename);
  const commentary = {id:row.id,updatedAt:row.updated_at,type:row.commentary_type,eventName:row.event_name,sources:row.sources,
    eventPublishedAt:row.event_published_at,commentaryDate:row.commentary_date,eventSummary:row.event_summary,commentary:row.commentary,recommendation:row.recommendation};
  const bytes = sourceFile ? await readFile(path.resolve(sourceDirectory,sourceFile.name)) : renderCommentaryPdf(commentary);
  if (sourceFile && sha(bytes)!==sourceFile.sha256) throw new Error('Source PDF differs from imported manifest: '+sourceFile.name);
  if (Buffer.from(bytes).subarray(0,5).toString()!=='%PDF-') throw new Error('Invalid PDF');
  const fileName = sourceFile ? path.basename(sourceFile.name) : row.event_name+'.pdf';
  const file = path.join(output,row.id+'.pdf');await writeFile(file,bytes);
  plan.push({id:row.id,revisionAt:row.updated_at,key:commentaryPdfKey(commentary),fileName,file,sha256:sha(bytes),size:bytes.length,original:!!sourceFile});
}
await writeFile(path.join(output,'plan.json'),JSON.stringify(plan,null,2));
console.log(JSON.stringify({mode:apply?'apply':'preview',bucket:'eastmoney',prefix:'research-commentary/',total:plan.length,originals:plan.filter(item=>item.original).length}));
if (!apply) process.exit(0);
const objectPath=key=>'/r2/buckets/eastmoney/objects/'+key.split('/').map(encodeURIComponent).join('/');
for (const item of plan) {
  const prior=await query('SELECT * FROM commentary_pdf WHERE commentary_id=? AND revision_at=?',[item.id,item.revisionAt]);
  if (prior.length && (prior[0].r2_key!==item.key || prior[0].sha256!==item.sha256)) throw new Error('Archive version conflict');
  let existing=null;
  try { existing=await request(objectPath(item.key)); } catch(error) { if(!String(error).endsWith('HTTP 404')) throw error; }
  if (existing) {
    if(sha(Buffer.from(await existing.arrayBuffer()))!==item.sha256)throw new Error('Existing R2 PDF differs; refusing overwrite');
  } else {
    const bytes=await readFile(item.file);
    await (await request(objectPath(item.key),{method:'PUT',headers:{'content-type':'application/pdf'},body:bytes})).body?.cancel();
  }
  const retrieved=await request(objectPath(item.key));
  if(sha(Buffer.from(await retrieved.arrayBuffer()))!==item.sha256)throw new Error('R2 PDF hash verification failed');
  await query(`INSERT INTO commentary_pdf(commentary_id,revision_at,r2_key,file_name,sha256,byte_size,archived_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(commentary_id,revision_at) DO NOTHING`,[item.id,item.revisionAt,item.key,item.fileName,item.sha256,item.size,new Date().toISOString()]);
}
const confirmed=await query('SELECT commentary_id,revision_at,r2_key,sha256,byte_size FROM commentary_pdf');
for(const item of plan)if(!confirmed.some(row=>row.commentary_id===item.id && row.revision_at===item.revisionAt && row.r2_key===item.key && row.sha256===item.sha256 && row.byte_size===item.size))throw new Error('D1 PDF archive readback failed');
await writeFile(path.join(output,'result.json'),JSON.stringify({verified:plan.length,originals:plan.filter(item=>item.original).length,generated:plan.filter(item=>!item.original).length},null,2));
console.log(JSON.stringify({verified:plan.length,bucket:'eastmoney',prefix:'research-commentary/'}));
