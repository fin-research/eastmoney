import { Client } from 'pg';
import { readQuantWorkbooks } from './quant-workbook-inputs.ts';
import { persistQuantInputs } from '../src/sync/quant-input-repository.ts';
import { upsertBondIssuance } from '../src/sync/bond-issuance-repository.ts';

const args=process.argv.slice(2), directory=args[args.indexOf('--directory')+1];
if(!args.includes('--directory')||!directory)throw new Error('--directory <quant/data> is required');
const endDate=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const {inputs,edb,manifest}=await readQuantWorkbooks(directory,endDate);
const client=new Client({connectionTimeoutMillis:20000,query_timeout:60000,connectionString:process.env.DATABASE_URL ?? process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE});
try {
  await client.connect();
  const existing=await client.query('SELECT indicator_code,observation_date::text,value::float8 FROM public.edb WHERE indicator_code=ANY($1::text[]) AND observation_date >= $2::date',[[...new Set(edb.map(r=>r.code))],'2019-01-01']);
  const index=new Map(existing.rows.map(r=>[`${r.indicator_code}:${r.observation_date}`,r.value]));
  const missing=edb.filter(r=>!index.has(`${r.code}:${r.observationDate}`));
  const conflicts=edb.filter(r=>index.has(`${r.code}:${r.observationDate}`)&&Math.abs(index.get(`${r.code}:${r.observationDate}`)!-r.value)>0.00011);
  console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'dry-run',manifest,edbMissing:missing.length,overlapDifferences:conflicts.length,
    existingPreserved:true,choiceEdbCalls:0}));
  if(args.includes('--apply')) {
    // Seed only absent keys; never replace online history with a workbook revision.
    let inserted=0;
    for(let offset=0;offset<missing.length;offset+=1500) {
      const result=await client.query(`INSERT INTO public.edb(indicator_code,observation_date,published_date,value)
        SELECT code,"observationDate"::date,date::date,value FROM jsonb_to_recordset($1::jsonb)
        AS x(code text,"observationDate" text,date text,value double precision)
        ON CONFLICT(indicator_code,observation_date) DO NOTHING`,[JSON.stringify(missing.slice(offset,offset+1500))]);
      inserted+=result.rowCount??0;
    }
    const stored=await persistQuantInputs(client,inputs.filter(row=>row.dataset!=='issue'),true);
    const bonds=await upsertBondIssuance(client,inputs.filter(row=>row.dataset==='issue'),true);
    console.log(JSON.stringify({edbInserted:inserted,inputFieldsInserted:stored,bondsInserted:bonds}));
  }
}finally{await client.end();}
