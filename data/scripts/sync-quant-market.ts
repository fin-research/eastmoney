import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { quantMarketRequests, fetchQuantMarketInputs } from '../src/sync/quant-market-sync.ts';
import { persistQuantInputs } from '../src/sync/quant-input-repository.ts';
import { upsertBondIssuance } from '../src/sync/bond-issuance-repository.ts';

const args=process.argv.slice(2);
const option=(key:string)=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
const start=option('--start'),end=option('--end'),cache=option('--cache-directory');
if(!args.includes('--apply')||!start||!end||!cache)throw new Error('--apply --start YYYY-MM-DD --end YYYY-MM-DD --cache-directory PATH required');
if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end||Date.parse(end)-Date.parse(start)>31*86400000)throw new Error('Use a bounded date range of at most 31 days');
const selected=option('--sources')?.split(',');
await mkdir(cache,{recursive:true,mode:0o700});
const request=async(route:string,params:URLSearchParams):Promise<unknown>=>{
  const key=createHash('sha256').update(route+'?'+params.toString()).digest('hex');
  const file=path.join(cache,key+'.json');
  if(args.includes('--replay'))return JSON.parse(await readFile(file,'utf8'));
  if(!process.env.DATA_API_BEARER_TOKEN)throw new Error('DATA_API_BEARER_TOKEN required for live calls');
  const url=new URL('https://eastmoney.hasbai.xyz/data'+route);url.search=params.toString();
  const response=await fetch(url,{headers:{Authorization:`Bearer ${process.env.DATA_API_BEARER_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(`Data API ${route}: HTTP ${response.status}`);
  const data=await response.json();await writeFile(file,JSON.stringify(data),{mode:0o600});return data;
};
const client=new Client({connectionString:process.env.DATABASE_URL??process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,connectionTimeoutMillis:20000,query_timeout:60000});
try{
  await client.connect();
  for(const spec of quantMarketRequests(start,end).filter(s=>!selected||selected.includes(s.id)||selected.includes(s.dataset))){
    try{
      const rows=await fetchQuantMarketInputs(request,spec,start,end);
      const count=spec.dataset==='issue'?await upsertBondIssuance(client,rows):await persistQuantInputs(client,rows);
      console.log(JSON.stringify({source:spec.id,rows:rows.length,stored:count}));
    }catch(error){
      console.error(JSON.stringify({source:spec.id,status:'failed',error:error instanceof Error?error.message:'failed'}));
      process.exitCode=1;
    }
  }
}finally{await client.end();}
