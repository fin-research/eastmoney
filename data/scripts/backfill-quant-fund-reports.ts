import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from 'pg';
import {parseQuantFundReport} from '../src/sync/quant-fund-report.ts';
import {persistQuantInputs} from '../src/sync/quant-input-repository.ts';
const args=process.argv.slice(2),directory=args[args.indexOf('--directory')+1];
if(!args.includes('--directory')||!directory)throw new Error('--directory PATH required');
const parsed=[];
for(const file of (await readdir(directory)).filter(f=>/^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort()) {
  const rows=parseQuantFundReport(await readFile(path.join(directory,file),'utf8'),file.slice(0,10));
  parsed.push({file,rows});
}
console.log(JSON.stringify({reports:parsed.length,fields:parsed.reduce((s,p)=>s+p.rows.length,0),mode:args.includes('--apply')?'apply':'dry-run'}));
if(args.includes('--apply')) {
  const client=new Client({connectionString:process.env.DATABASE_URL??process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,connectionTimeoutMillis:20000,query_timeout:60000});
  try{
    await client.connect();
    for(const {file,rows} of parsed) {
      const count=await persistQuantInputs(client,rows);
      console.log(JSON.stringify({date:file.slice(0,10),stored:count}));
    }
  }finally{await client.end();}
}
