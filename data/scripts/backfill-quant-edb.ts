import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from 'pg';
import {fetchDmFundingRateRows,normalizeChoiceEconomicIndicatorRows} from '../src/sync/economic-indicator-sync.ts';
import {persistEconomicIndicators} from '../src/sync/economic-indicators-repository.ts';

const args=process.argv.slice(2),option=(key:string)=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
const cache=option('--cache-directory');
if(!args.includes('--apply')||!cache)throw new Error('--apply --cache-directory PATH required; reads only explicitly selected sources');
await mkdir(cache,{recursive:true,mode:0o700});
const client=new Client({connectionString:process.env.DATABASE_URL??process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,connectionTimeoutMillis:20000,query_timeout:60000});
try{
  await client.connect();
  if(args.includes('--dm-shibor')) {
    for(const code of ['ShiborO/N','Shibor1W','Shibor3M']) {
      const file=path.join(cache,code.replace('/','-')+'.json');
      let rows;
      if(args.includes('--replay'))rows=JSON.parse(await readFile(file,'utf8'));
      else {
        const result=await fetchDmFundingRateRows(async(route,params)=>{
          const url=new URL('https://eastmoney.hasbai.xyz/data'+route);url.search=params.toString();
          const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
          if(!response.ok)throw new Error(`DM history HTTP ${response.status}`);
          return response.json();
        },'full',new Date(),[code]);
        rows=result.rows;await writeFile(file,JSON.stringify(rows),{mode:0o600});
      }
      const stored=await persistEconomicIndicators(client,rows);
      console.log(JSON.stringify({source:code,rows:rows.length,first:rows[0]?.observationDate,last:rows.at(-1)?.observationDate,stored:stored.rowCount}));
    }
  }
  const macroFile=option('--macro-json');
  if(macroFile) {
    const payload=JSON.parse(await readFile(macroFile,'utf8'));
    const rows=payload.rows;
    if(payload.function!=='EDB'||!Array.isArray(rows)||rows.length>36)throw new Error('Invalid bounded 2019 macro backfill');
    if(rows.some(r=>!['EMM00087086','EMM00634721'].includes(r.code)||!/^2019-\d{2}-\d{2}$/.test(r.date)||r.RESULT===null||!Number.isFinite(Number(r.RESULT))))throw new Error('Unexpected macro observation');
    const normalized=normalizeChoiceEconomicIndicatorRows(rows,'2020-12-31');
    const dates=new Map(normalized.map(r=>[`${r.code}:${r.observationDate}`,r.date]));
    const result=await client.query(`INSERT INTO public.edb(indicator_code,observation_date,published_date,value)
      SELECT code,date::date,published::date,value FROM jsonb_to_recordset($1::jsonb) AS x(code text,date text,published text,value double precision)
      ON CONFLICT(indicator_code,observation_date) DO NOTHING`,[JSON.stringify(rows.map(r=>({code:r.code,date:r.date,published:dates.get(`${r.code}:${r.date}`)??null,value:Number(r.RESULT)})))]);
    console.log(JSON.stringify({source:'2019-macro',stored:result.rowCount,unknownReleaseDates:rows.length-normalized.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}));
  }
}finally{await client.end();}
