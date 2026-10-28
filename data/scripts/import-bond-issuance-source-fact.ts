import { readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Client} from 'pg';
import {issuanceSourceFact,recordIssuanceSourceFact} from '../src/sync/bond-issuance-source-fact.ts';
const args=process.argv.slice(2),arg=(key:string)=>{const i=args.indexOf(key);if(i<0||!args[i+1])throw Error(`Required ${key}`);return args[i+1]!;};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const fact=issuanceSourceFact.parse(JSON.parse(await readFile(arg('--fact'),'utf8')));
const reviewBytes=await readFile(arg('--review')),review=JSON.parse(reviewBytes.toString());
const approved=arg('--review-sha');
if(hash(reviewBytes)!==approved||approved!==fact.reviewSha256||hash(await readFile(arg('--pdf')))!==fact.sourceSha256||
  review.batch!==fact.batch||review.actualIssuanceStatus!==fact.status||review.actualIssuanceAnnouncementDate!==fact.announcementDate||review.resultPdfSha256!==fact.sourceSha256||review.resultUrl!==fact.sourceUrl||review.resultPhysicalPage!==fact.physicalPage||
  review.resultPageVisuallyReviewed!==true||review.code!==fact.code||review.frozenRecord?.issue_date!==fact.issueDate||
  review.frozenRecord?.original_tenor_years!==fact.tenorYears||review.frozenRecord?.short_name!==fact.shortName||
  review.frozenRecord?.issuer_name!==fact.issuerName)throw Error('Approved review/PDF/identity mismatch');
const client=new Client({connectionString:process.env.DATABASE_URL??process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,application_name:'bond-issuance-source-fact',connectionTimeoutMillis:20000});
try{await client.connect();await client.query('BEGIN');const result=await recordIssuanceSourceFact(client as never,fact,args.includes('--apply'));await client.query(args.includes('--apply')?'COMMIT':'ROLLBACK');console.log(JSON.stringify({...result,reviewSha256:approved,pdfSha256:fact.sourceSha256,choiceCalls:0}));}
catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{await client.end();}
