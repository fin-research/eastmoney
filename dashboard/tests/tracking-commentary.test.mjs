import { commentaryDatabase as database } from './helpers/commentary-database.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compileExtractiveCommentary, extractiveCommentarySchema, retrieveCommentaryResearch, commentaryGenerationOptions, commentaryPassages, commentarySelectionSchema, compileCommentarySelection } from '../src/lib/server/commentary-generation.ts';
import { commentaryError } from '../src/lib/server/commentary-http.ts';
import { AiGatewayResponseError, AiGatewayRetryError } from '../src/lib/server/ai-gateway.ts';
import { createCommentary, updateCommentary, getCommentary, commentaryRevisions, listCommentaries, loadCommentaryStyleReferences } from '../src/lib/server/commentary-repository.ts';
import { generateCommentarySchema, commentaryDraftSchema } from '../src/lib/commentary.ts';
import { renderCommentaryPdf, commentaryPdfKey } from '../src/lib/research-commentary-pdf.ts';
import { archiveCommentaryPdf, downloadCommentaryPdf, readUploadedCommentaryPdf } from '../src/lib/server/commentary-pdf.ts';
import { parseResearchContent } from '../src/lib/report-content.ts';

const sentence = '融资需求下降，资金价格中枢下移，发行窗口已经打开。';
const source = { sourceId:'S1',sourceKey:'report/2026-09-17/报告.md',title:'报告',institution:'机构甲',publishedAt:'2026-09-17',text:`核心观点\n${sentence}\n如果资金保持宽松，长端利率将继续下行。` };
const output = { eventSummary:{sourceId:'S1',text:sentence},sections:[{heading:'资金价格下移打开融资窗口',quotes:[{sourceId:'S1',text:sentence}]},{heading:'宽松资金支撑长端利率下行',quotes:[{sourceId:'S1',text:'如果资金保持宽松，长端利率将继续下行。'}]}],recommendation:'融资发行方面，前置安排中长期公司债发行，利用资金价格中枢下移的窗口锁定负债成本。',recommendationSources:['S1'] };

test('interactive generation streams phase labels without exposing unvalidated model content and reports retries', () => {
  const phases = [];
  const options = commentaryGenerationOptions('draft',20,message => phases.push(message));
  assert.equal(options.requestTimeoutMs,300000);
  assert.equal(options.taskType,'commentary');
  options.onAttempt('primary');
  options.onReasoningSummary({id:'r',text:'private reasoning'});
  options.onReasoningSummary({id:'r',text:'more reasoning'});
  options.onTextDelta('unvalidated JSON');
  options.onTextDelta('more JSON');
  options.onAttempt('retry');
  options.onTextDelta('replacement JSON');
  assert.deepEqual(phases,['AI 选取原文','组织判断与建议','生成点评','AI 重试选材','生成点评']);
});

test('selection uses complete source sentences and preserves numbers, conditions, quoted punctuation and source offsets', () => {
  const doc = {...source,text:'观点\n- 如果资金价格低于1.5%，发行成本将继续下降。\n机构判断：“债牛仍有支撑。”另一完整判断指出，信用需求仍然偏弱。'};
  const passages = commentaryPassages([doc]);
  assert.deepEqual(passages.map(p => p.text), ['如果资金价格低于1.5%，发行成本将继续下降。','机构判断：“债牛仍有支撑。”','另一完整判断指出，信用需求仍然偏弱。']);
  assert.ok(passages.every(p => doc.text.slice(p.startOffset,p.endOffset) === p.text));
  const selection = { eventSummaryId:'Q1',sections:[{heading:'宽松资金降低融资成本',quoteIds:['Q1']},{heading:'弱信用继续支撑债市',quoteIds:['Q2','Q3']}],recommendation:output.recommendation };
  const compiled = compileCommentarySelection(commentarySelectionSchema(passages).parse(selection),passages,[doc]);
  assert.equal(compiled.eventSummary,passages[0].text);
  assert.ok(compiled.evidence.every(e => doc.text.slice(e.startOffset,e.endOffset) === e.text));
  assert.equal(commentarySelectionSchema(passages).safeParse({...selection,eventSummaryId:'Q999'}).success,false);
  assert.throws(() => compileExtractiveCommentary({...output,eventSummary:{sourceId:'S1',text:'发行成本将继续下降。'}},[doc]),/句中/);
});

test('AI failures expose safe actionable timeout and validation codes with trace IDs', async () => {
  const failure = {provider:'custom-codex',status:200,gatewayLogId:'log-1',retryable:true,message:'The operation was aborted due to timeout'};
  const response = commentaryError(new AiGatewayRetryError([failure,{...failure,gatewayLogId:'log-2'}]));
  assert.equal(response.status,504);
  const result = await response.json();
  assert.equal(result.code,'AI_RESPONSE_TIMEOUT');assert.equal(result.attempts,2);
  assert.deepEqual(result.gatewayLogIds,['log-1','log-2']);
  assert.match(result.error,/HTTP 200/);
  const invalid = await commentaryError(new AiGatewayResponseError({...failure,message:'output failed business schema: private source text'})).json();
  assert.equal(invalid.code,'AI_OUTPUT_INVALID');assert.doesNotMatch(JSON.stringify(invalid),/private source text/);
});

test('excerpt compiler keeps source words and offsets, rejects rewritten or condition-stripped quotations', () => {
  const result = compileExtractiveCommentary(extractiveCommentarySchema.parse(output),[source]);
  assert.equal(result.eventSummary,sentence);
  assert.equal(source.text.slice(result.evidence[0].startOffset,result.evidence[0].endOffset),sentence);
  assert.throws(() => compileExtractiveCommentary({...output,eventSummary:{sourceId:'S1',text:'资金成本下降，建议立刻发行。'}},[source]), /不一致/);
  assert.throws(() => compileExtractiveCommentary({...output,eventSummary:{sourceId:'S1',text:'长端利率将继续下行。'}},[source]), /句中/);
  assert.throws(() => compileExtractiveCommentary({...output,recommendationSources:['S9']},[source]), /来源/);
  assert.throws(() => compileExtractiveCommentary({...output,recommendation:'融资发行方面，保持谨慎，密切关注市场变化。'},[source]), /套话/);
});

test('research retrieval sends Shanghai hard bounds, max 50 and preserves full returned text', async () => {
  let calls = 0;
  const longText = sentence.repeat(150);
  const documents = await retrieveCommentaryResearch('融资环境','2026-09-11','2026-09-17',async (_url,options) => {
    calls++; const args = JSON.parse(options.body).params.arguments;
    assert.equal(args.ai_search_options.retrieval.max_num_results,50);
    assert.deepEqual(args.ai_search_options.retrieval.filters,{type:{$eq:'研报'},published_at:{$gte:Date.parse('2026-09-11T00:00:00+08:00'),$lte:Date.parse('2026-09-17T23:59:59.999+08:00')}});
    const chunk = (key,published_at) => ({text:longText,item:{key,metadata:{source:'机构甲',published_at}}});
    return Response.json({result:{content:[{type:'text',text:JSON.stringify({result:{chunks:[chunk('report/2026-09-17/报告.md',Date.parse('2026-09-17T12:00:00+08:00')),chunk('report/2025-01-01/旧报告.md',Date.parse('2025-01-01T00:00:00+08:00'))]}})}]}});
  });
  assert.equal(calls,2);assert.equal(documents.length,1);assert.equal(documents[0].text,longText);
});

const draft = {eventName:'融资环境专题',type:'current_affairs',sources:'机构甲',eventPublishedAt:'2026-09-17',commentaryDate:'2026-09-17',eventSummary:sentence,commentary:sentence,recommendation:''};
test('shared D1 archive preserves legacy records, appends before-image revisions and rejects stale saves', async () => {
  const {db,sqlite} = database();
  const initial = await createCommentary(db,{...draft,policyId:null});
  const generated = await updateCommentary(db,initial.id,draft,initial.updatedAt,{model:'test-model',promptVersion:'test-v1',evidence:[],search:{startDate:'2026-09-11',endDate:'2026-09-17',query:draft.eventName}});
  const edited = await updateCommentary(db,initial.id,{...draft,commentary:'人工修订内容'},generated.updatedAt);
  await assert.rejects(updateCommentary(db,initial.id,draft,generated.updatedAt),/已更新/);
  const revisions = await commentaryRevisions(db,initial.id);
  assert.equal(revisions.length,3);assert.equal(revisions[0].content.commentary,'人工修订内容');assert.equal(revisions[1].content.edited,false);
  assert.equal((await getCommentary(db,initial.id)).policyId,null);
  assert.equal((await listCommentaries(db,{q:'融资'})).items.length,1);
  assert.equal((await listCommentaries(db,{q:'%'})).items.length,0);
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
  sqlite.close();
});

test('missing archive dates remain editable but invalid calendar dates fail', () => {
  assert.equal(commentaryDraftSchema.parse({...draft,commentaryDate:''}).commentaryDate,'');
  assert.equal(commentaryDraftSchema.safeParse({...draft,eventPublishedAt:'2026-02-30'}).success,false);
  assert.equal(generateCommentarySchema.safeParse({startDate:'2026-09-18',endDate:'2026-09-17',updatedAt:'v'}).success,false);
});

test('historical meeting tables render safely as cells rather than HTML', () => {
  const blocks = parseResearchContent('比较\n| 维度 | 表述 |\n| --- | --- |\n| 货币 | <script>attack</script><br>宽松 |\n下一段');
  const table = blocks.find(b => b.kind === 'table');
  assert.deepEqual(table.headers,['维度','表述']);assert.equal(table.rows[0][1],'<script>attack</script>\n宽松');
});

test('archive parser preserves all numbered headings, missing fields and idempotent import', () => {
  const program = `import importlib.util,json\nspec=importlib.util.spec_from_file_location('imp','scripts/import-tracking-commentaries.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ntext='事件名称：测试宏观事件\\n发布时间：2026年9月17日\\n汇总时间：2026年9月18日\\n【事件摘要】\\n摘要原文\\n【时事快评】\\n第一项判断\\n原文甲\\n第二项判断\\n原文乙'\nr=m.structure(text,'海外事件-260918.docx')\nassert r['commentaryDate']=='2026-09-18'\nassert '第二项判断' in r['commentary']\nassert r['recommendation']==''\nr.update(id='test',originalText=text,sourceFiles=[],importKey='hash')\nprint(json.dumps({'r':r,'sql':m.import_sql([r],'2026-09-18T00:00:00Z')}))`;
  const process = spawnSync('python3',['-c',program],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(process.status,0,process.stderr);
  const result=JSON.parse(process.stdout);const {sqlite}=database();sqlite.exec(result.sql);sqlite.exec(result.sql);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM commentary').get().n,1);
  assert.equal(sqlite.prepare('SELECT commentary FROM commentary').get().commentary,result.r.commentary);sqlite.close();
});


test('PDF archive uses classified version keys, is idempotent, and downloads only indexed R2 objects', async () => {
  const {db,sqlite}=database();
  const current=await createCommentary(db,{...draft,policyId:null});
  const objects=new Map();let writes=0;
  const env={DB:db,EASTMONEY:{async put(key,bytes,options){writes++;objects.set(key,{bytes,options});return {size:bytes.length};},async get(key){const value=objects.get(key);return value ? {body:value.bytes,httpEtag:'"pdf"'} : null;}}};
  const result=await archiveCommentaryPdf(env,current.id,current.updatedAt);
  assert.equal(result.key,commentaryPdfKey(current));assert.ok(result.key.startsWith('research-commentary/时事快评/'));
  assert.equal(result.sha256.length,64);assert.equal(result.size,objects.get(result.key).bytes.length);
  assert.deepEqual(await archiveCommentaryPdf(env,current.id,current.updatedAt),result);assert.equal(writes,1);
  const response=await downloadCommentaryPdf(env,current.id);
  assert.equal(response.headers.get('Content-Type'),'application/pdf');assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-');
  const changed=await updateCommentary(db,current.id,{...draft,commentary:'新版本正文内容'},current.updatedAt);
  await assert.rejects(archiveCommentaryPdf(env,current.id,current.updatedAt),/已更新/);
  await assert.rejects(downloadCommentaryPdf(env,current.id),/尚未归档/);
  await archiveCommentaryPdf(env,current.id,changed.updatedAt);assert.equal(objects.size,2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM commentary_pdf').get().n,2);sqlite.close();
});

test('PDF renderer preserves Chinese text, escapes PDF syntax and paginates without truncation',()=>{
  const body=renderCommentaryPdf({...draft,eventName:'融资 (研究) \\ 测试',commentary:'资金价格下移，融资窗口已经打开。'.repeat(400)});
  const text=new TextDecoder().decode(body);
  assert.match(text,/\/BaseFont \/STSong-Light/);assert.match(text,/\/ToUnicode/);
  const count=Number(text.match(/\/Type \/Pages \/Kids \[[^\]]+\] \/Count (\d+)/)[1]);assert.ok(count>1);
  const streams=[...text.matchAll(/<([0-9a-f]+)> Tj/g)].map(match=>match[1].match(/.{4}/g).map(hex=>String.fromCharCode(parseInt(hex,16))).join('')).join('');
  assert.ok(streams.includes('融资 (研究) \\ 测试'));assert.equal((streams.match(/资金价格下移/g)||[]).length,400);
});


test('style references use the latest three same-type human drafts, excluding current and future records',async()=>{
  const {db,sqlite}=database();
  const current=await createCommentary(db,{...draft,policyId:null});
  for(let i=1;i<=5;i++)await createCommentary(db,{...draft,eventName:'参考稿'+i,commentaryDate:'2026-09-'+String(i).padStart(2,'0'),policyId:null});
  await createCommentary(db,{...draft,eventName:'未来稿',commentaryDate:'2026-10-01',policyId:null});
  await createCommentary(db,{...draft,eventName:'海外稿',type:'overseas_event',policyId:null});
  const references=await loadCommentaryStyleReferences(db,current.id,'current_affairs','2026-09-17');
  assert.deepEqual(references.map(item=>item.eventName),['参考稿5','参考稿4','参考稿3']);
  assert.ok(references.every(item=>item.id!==current.id));sqlite.close();
});

test('frontend PDF upload is bounded and archives the exact bytes for download',async()=>{
  const {db,sqlite}=database();const current=await createCommentary(db,{...draft,policyId:null});
  const bytes=new TextEncoder().encode('%PDF-1.7\nfrontend-layout\n%%EOF\n');
  const request=new Request('https://example.test/pdf',{method:'POST',body:bytes});
  assert.deepEqual(await readUploadedCommentaryPdf(request),bytes);
  await assert.rejects(readUploadedCommentaryPdf(new Request('https://example.test/pdf',{method:'POST',body:'not PDF'})),/格式/);
  await assert.rejects(readUploadedCommentaryPdf(new Request('https://example.test/pdf',{method:'POST',headers:{'content-length':String(17*1024*1024)},body:bytes})),/16MB/);
  let stored;
  const env={DB:db,EASTMONEY:{async put(_key,value){stored=value;return {size:value.length};},async get(){return {body:stored,httpEtag:'"pdf"'};}}};
  await archiveCommentaryPdf(env,current.id,current.updatedAt,bytes);
  assert.deepEqual(stored,bytes);assert.deepEqual(new Uint8Array(await (await downloadCommentaryPdf(env,current.id)).arrayBuffer()),bytes);sqlite.close();
});


for (const winnerIndex of [0, 1]) {
  test(`concurrent PDF uploads preserve R2 winner ${winnerIndex + 1} and its hash`, { timeout: 5000 }, async () => {
    const { db, sqlite } = database();
    try {
      const current = await createCommentary(db, { ...draft, policyId: null });
      const uploads = ['%PDF-1.7 first %%EOF', '%PDF-1.7 second %%EOF'].map(text => new TextEncoder().encode(text));
      const pending = [], entered = Promise.withResolvers();
      let object = null;
      const env = { DB: db, EASTMONEY: {
        async put(key, bytes, options) {
          assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
          return new Promise(resolve => {
            pending.push({ key, bytes, options, resolve });
            if (pending.length === 2) entered.resolve();
          });
        },
        async head() { return object; },
        async get() { return { body: object.bytes, httpEtag: '"pdf"' }; },
      } };
      const results = Promise.all(uploads.map(bytes => archiveCommentaryPdf(env, current.id, current.updatedAt, bytes)));
      await entered.promise;
      // Hashing is asynchronous: invocation order does not determine the first
      // conditional R2 write. Exercise both winners without timing assumptions.
      const winner = pending.find(request => request.bytes === uploads[winnerIndex]);
      object = { key: winner.key, bytes: winner.bytes, size: winner.bytes.length, customMetadata: winner.options.customMetadata };
      for (const request of pending) request.resolve(request === winner ? object : null);
      const [one, two] = await results;
      assert.equal(one.sha256, two.sha256);
      assert.equal(one.sha256, createHash('sha256').update(uploads[winnerIndex]).digest('hex'));
      assert.equal(one.size, uploads[winnerIndex].length);
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM commentary_pdf').get().n, 1);
      const updated = await updateCommentary(db, current.id, { ...draft, commentary: '下一版本' }, current.updatedAt);
      assert.notEqual(updated.updatedAt, current.updatedAt);
      assert.deepEqual(new Uint8Array(await (await downloadCommentaryPdf(env, current.id, current.updatedAt)).arrayBuffer()), uploads[winnerIndex]);
    } finally { sqlite.close(); }
  });
}


test('commentary migration preserves every stored record, relation, revision and PDF key without aliases', async()=>{
  const {db,sqlite}=database({unified:false});
  try {
    sqlite.exec(`INSERT INTO policy_event VALUES('p','政策','摘要','other','[]','2026-10-26','first','last','created','updated');
      INSERT INTO research_commentary VALUES('c','p','policy_tracking','历史标题','来源','2026-10-26','2026-10-26','历史摘要','历史正文','历史建议','model','historical-prompt','generated',0,'created','v1');
      INSERT INTO tracking_commentary_workspace(commentary_id,origin,original_text,source_files_json) VALUES('c','import','历史原文','[{"name":"原件.docx"}]');
      UPDATE research_commentary SET commentary='修订正文',updated_at='v2' WHERE id='c';
      INSERT INTO research_commentary_pdf VALUES('c','v2','research-commentary/政策跟踪/c/v2.pdf','原件.pdf','original-hash',10,'archive-time');`);
    const tables={research_commentary:'commentary',tracking_commentary_workspace:'commentary_workspace',tracking_commentary_revision:'commentary_revision',research_commentary_pdf:'commentary_pdf'};
    const before=Object.fromEntries(Object.keys(tables).map(name=>[name,JSON.stringify(sqlite.prepare(`SELECT * FROM ${name}`).all())]));
    sqlite.exec(readFileSync(new URL('../migrations/1021_unify_commentary.sql',import.meta.url),'utf8'));
    for(const [oldName,name] of Object.entries(tables)) {
      assert.equal(JSON.stringify(sqlite.prepare(`SELECT * FROM ${name}`).all()),before[oldName]);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name=?').get(oldName).n,0);
    }
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal((await getCommentary(db,'c')).policy.id,'p');
    sqlite.exec("UPDATE commentary SET commentary='新修订',updated_at='v3' WHERE id='c'");
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM commentary_revision').get().n,2);
    assert.ok(JSON.parse(sqlite.prepare("SELECT content_json FROM commentary_revision WHERE saved_at='v2'").get().content_json).commentary==='修订正文');
    const response=await downloadCommentaryPdf({DB:db,EASTMONEY:{async get(key){assert.equal(key,'research-commentary/政策跟踪/c/v2.pdf');return {body:'original-pdf',httpEtag:'original-etag'}}}},'c','v2');
    assert.equal(await response.text(),'original-pdf');
    assert.equal(sqlite.prepare('SELECT id FROM commentary WHERE policy_id=?').get('p').id,'c');
  }finally{sqlite.close();}
});
