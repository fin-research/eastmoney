import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { researchSearchSchema, searchArguments, researchSearch, parseSearchResponse, handleResearchSearch } = await import('../src/lib/server/research-search.ts');
const data={success:true,result:{chunks:[{text:'原文',item:{key:'article/report/a.md',metadata:{published_at:1792700000000,type:'研报'}},scoring_details:{vector_score:0.8,keyword_score:0.9,fusion_method:'rrf'}}],hybrid_meta:{x:1}}};
test('search preserves original query, options, millisecond filters and full chunks/scoring',async()=>{
 const input={query:'央行',ai_search_options:{cache:{enabled:false},retrieval:{max_num_results:50,retrieval_type:'hybrid',filters:{type:{$eq:'研报'},published_at:{$gte:1792598400000,$lt:1793203200000}},fusion_method:'rrf'}}};
 assert.deepEqual(researchSearchSchema.parse(input),input);
 const result=await researchSearch(input,undefined,async(url,init)=>{assert.equal(url,'https://research.hasbai.xyz/mcp');assert.equal(new Headers(init.headers).has('Authorization'),false);const rpc=JSON.parse(init.body);assert.equal(rpc.params.name,'search');assert.deepEqual(rpc.params.arguments,input);return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}});});
 assert.deepEqual(result,data);
});
test('default hard date filter spans seven Shanghai calendar days and result count is always50',()=>{
 const value=searchArguments({query:'a'},Date.parse('2026-10-28T08:00:00+08:00'));
 assert.deepEqual(value.ai_search_options.retrieval,{max_num_results:50,filters:{published_at:{$gte:Date.parse('2026-10-22T00:00:00+08:00'),$lt:Date.parse('2026-10-29T00:00:00+08:00')}}});
 for(const input of [{query:''},{query:'a',url:'https://evil.test'},{query:'a',ai_search_options:{retrieval:{max_num_results:5}}},{query:'a',ai_search_options:{retrieval:{filters:{published_at:{$gte:'2026-10-01'}}}}}]) assert.equal(researchSearchSchema.safeParse(input).success,false);
});
test('JSON and multiline SSE decode matching MCP IDs and reject upstream error/malformed responses',()=>{
 const rpc={jsonrpc:'2.0',id:'a',result:{content:[{type:'text',text:JSON.stringify(data)}]}};
 assert.deepEqual(parseSearchResponse('event: message\ndata: '+JSON.stringify(rpc)+'\n\n','a'),data);
 for(const value of [{jsonrpc:'2.0',id:'a',error:{message:'oops'}},{...rpc,result:{isError:true,content:[]}},{...rpc,result:{content:[{type:'text',text:JSON.stringify({success:false,result:{chunks:[]}})}]}},{...rpc,id:'wrong'},{}]) assert.throws(()=>parseSearchResponse(JSON.stringify(value),'a'));
});
test('HTTP failure, oversized response, malformed input and upstream failure remain errors',async()=>{
 for(const fetcher of [async()=>new Response('down',{status:503}),async()=>Response.json({}),async()=>new Response('x'.repeat(6*1024*1024+1))]) {
  const response=await handleResearchSearch(new Request('https://local/api/research/search',{method:'POST',body:JSON.stringify({query:'a'})}),fetcher);assert.equal(response.status,502);
 }
 const invalid=await handleResearchSearch(new Request('https://local',{method:'POST',body:'{'})); assert.equal(invalid.status,400);
});

test('cancelled caller propagates abort and oversized requests return413',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>researchSearch({query:'a'},controller.signal,async(_url,init)=>{assert.equal(init.signal.aborted,true);init.signal.throwIfAborted();}),{name:'AbortError'});
 const response=await handleResearchSearch(new Request('https://local',{method:'POST',body:'x'.repeat(1024*1024+1)}),async()=>assert.fail('must not fetch'));
 assert.equal(response.status,413);
});
