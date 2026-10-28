/** Offline replay only. Successful CSS responses are durable before projection. */
import {readFile,readdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from 'pg';
import {applyPlacementResponse} from '../src/sync/bond-placement-sync.ts';
import type {DatabaseClient} from '../src/sync/postgres.ts';
const args=process.argv.slice(2),files:string[]=[];
let apply=false;
for(let i=0;i<args.length;i++) {
  if(args[i]==='--apply')apply=true;
  else if(args[i]==='--file'){const file=args[++i];if(!file)throw new Error('Missing file');files.push(file);}
  else if(args[i]==='--directory'){
    const directory=args[++i];if(!directory)throw new Error('Missing directory');
    for(const name of (await readdir(directory)).filter(n=>/^batch-.*\.json$/.test(n)).sort())files.push(join(directory,name));
  } else throw new Error('Unknown argument');
}
if(!files.length)throw new Error('Specify --file or --directory');
const client=new Client({connectionString:process.env.DATABASE_URL??process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,connectionTimeoutMillis:15000});
const db=<T>(operation:(client:DatabaseClient)=>Promise<T>)=>operation(client);
try {
 await client.connect();
 const known=await client.query<{code:string;date:string}>('SELECT bond_code AS code,issue_date::text AS date FROM public.bond_issuance');
 const dates=new Map(known.rows.map(r=>[r.code,r.date]));
 const sources=[];
 for(const path of files) {
  const bytes=await readFile(path),wrapper=JSON.parse(bytes.toString()),payload=wrapper.payload??wrapper;
  if((wrapper.status_code!==undefined&&wrapper.status_code!==200)||(wrapper.error_code!==undefined&&wrapper.error_code!==0)||payload.function!=='CSS'||!Array.isArray(payload.rows)) {
   sources.push({source:basename(path),status:'skipped_unsuccessful'});continue;
  }
  const rows=payload.rows as Array<Record<string,unknown>>;
  const unmatched=rows.filter(r=>!dates.has(String(r.code).toUpperCase()));
  if(unmatched.length)throw new Error(`Unmatched cached codes in ${basename(path)}: ${unmatched.length}`);
  const codes=rows.map(r=>String(r.code).toUpperCase());
  if(new Set(codes).size!==codes.length)throw new Error('Duplicate cached code');
  const digest=createHash('sha256').update(bytes).digest('hex');
  const sourceDates=Object.fromEntries(codes.map(code=>[code,dates.get(code)]));
  if(apply) {
   await applyPlacementResponse(db,sourceDates as Record<string,string>,payload,new Date().toISOString().slice(0,10));
  }
  sources.push({source:basename(path),sha256:digest,rows:rows.length,status:apply?'applied':'planned'});
 }
 console.log(JSON.stringify({mode:apply?'applied':'plan',sources},null,2));
} finally {await client.end();}
