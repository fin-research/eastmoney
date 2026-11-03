import { readFileSync } from 'node:fs';
import { expect, it, vi, afterEach, beforeEach } from 'vitest';
const network = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }));
vi.mock('../src/choice/native/transport', async importOriginal => {
  const original = await importOriginal<typeof import('../src/choice/native/transport')>();
  return { ...original, exchange: network.exchange };
});
vi.mock('cloudflare:sockets', () => ({ connect: () => { throw new Error('Real sockets forbidden'); } }));
import { ChoiceSession } from '../src/choice/native/session';
const tables: Record<string,string> = JSON.parse(readFileSync(new URL('./fixtures/choice-native/sdk-table-fixtures.json',import.meta.url),'utf8'));
const quota: {percent:string} = JSON.parse(readFileSync(new URL('./fixtures/choice-native/quota-fixtures.json',import.meta.url),'utf8'));
const fromHex = (hex:string) => new Uint8Array(Buffer.from(hex,'hex'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => vi.clearAllMocks());
function createActor(): ChoiceSession {
  const values = new Map<string,unknown>();
  const storage = {get:async(key:string)=>values.get(key), put:async(key:string,value:unknown)=>{values.set(key,value);},delete:async(key:string)=>values.delete(key)};
  const servers = Object.fromEntries(['3','6','19','20'].map(type=>[type,{hostname:'synthetic.invalid',port:Number(type)}]));
  const env = {CHOICE_SERVERS:JSON.stringify({...servers,statisticsOrigin:'https://synthetic.invalid/'}),CHOICE_CREDENTIALS:JSON.stringify({mode:'auto',uid:'fixture',ctoken:'synthetic',utoken:'synthetic',deviceId:'synthetic',deviceModel:'MACMD5'}),CHOICE_OTHER_LIMIT:{limit:async()=>({success:true})}} as unknown as Cloudflare.Env;
  return new ChoiceSession({storage} as unknown as DurableObjectState,env);
}
function nativeFrame(body: Uint8Array) {
  const header = new Uint8Array(13); new DataView(header.buffer).setUint32(1,13 + body.length,true);
  return {header,body};
}
function syntheticLogin() { return nativeFrame(new TextEncoder().encode(JSON.stringify({Code:0,Data:{BaseInfo:{UniqueId:'fixture',Token:'synthetic-token',SessionID:'synthetic-session',Ctoken:'synthetic-ctoken',Utoken:'synthetic-utoken'}}}))); }
it('runs native CSS metadata and SDK table decoding and reuses metadata for the next query', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real HTTP forbidden'); }));
  const commands: string[] = [];
  network.exchange.mockImplementation(async (endpoint: {port:number}, frame: Uint8Array) => {
    const header = new Uint8Array(13); new DataView(header.buffer).setUint32(1,13,true);
    if (endpoint.port === 19) return {header,body:new TextEncoder().encode(JSON.stringify({Code:0,Data:{BaseInfo:{UniqueId:'fixture',Token:'synthetic-token',SessionID:'synthetic-session',Ctoken:'synthetic-ctoken',Utoken:'synthetic-utoken'}}}))};
    const command = new TextDecoder().decode(frame.subarray(14)); commands.push(command);
    if (command.includes('$name=EM_API_PERCENTFLAG')) return {header,body:fromHex(quota.percent)};
    if (command.includes('$name=Code_Type')) return {header,body:new Uint8Array(readFileSync(new URL('./fixtures/choice-native/codeinfo.bin',import.meta.url)))};
    if (command.includes('$name=em_css')) return {header,body:fromHex(tables.cssPct!)};
    throw new Error('Unexpected synthetic query');
  });
  const session = createActor();
  const request=()=>new Request('https://choice.session.internal/query/css',{method:'POST',body:JSON.stringify({codes:'000001.SH',indicators:'PCT'})});
  for(let i=0;i<2;i++) {
    const response=await session.fetch(request());expect(response.status, JSON.stringify({commands, calls:network.exchange.mock.calls.map(([endpoint])=>endpoint)})).toBe(200);
    expect(await response.json()).toEqual({function:'CSS',fields:['code','PCT'],rows:[{code:'000001.SH',PCT:1250}]});
  }
  expect(commands.filter(command=>command.includes('$name=EM_API_PERCENTFLAG'))).toHaveLength(1);
  expect(commands.filter(command=>command.includes('$name=Code_Type'))).toHaveLength(1);
  expect(commands.filter(command=>command.includes('$name=em_css'))).toHaveLength(2);
});

it('runs CSD3 after the real calendar codec and retains missing-code null rows', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real HTTP forbidden'); }));
  const commands: string[] = [];
  network.exchange.mockImplementation(async (endpoint: {port:number}, frame: Uint8Array) => {
    if(endpoint.port === 19) return syntheticLogin();
    const command = new TextDecoder().decode(frame.subarray(14)); commands.push(command);
    if(command.includes('$name=EM_API_PERCENTFLAG')) return nativeFrame(fromHex(quota.percent));
    if(command.includes('$name=Code_Type')) return nativeFrame(new Uint8Array(readFileSync(new URL('./fixtures/choice-native/codeinfo.bin',import.meta.url))));
    if(command.includes('$name=Const_TradeDate')) return nativeFrame(fromHex(tables.tradedates!));
    if(command.includes('$name=em_csd_2')) return nativeFrame(fromHex(tables.csd3!));
    throw new Error('Unexpected synthetic CSD query');
  });
  const response = await createActor().fetch(new Request('https://choice.session.internal/query/csd',{method:'POST',body:JSON.stringify({codes:'000001.SH,600000.SH',indicators:'CLOSE',startDate:'2026-10-30',endDate:'2026-10-30',options:'Period=1,FillData=0,AdjustFlag=1'})}));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({function:'CSD',fields:['code','date','CLOSE'],rows:[{code:'000001.SH',date:'2026-10-30',CLOSE:12.5},{code:'600000.SH',date:'2026-10-30',CLOSE:null}]});
  expect(commands.findIndex(command=>command.includes('$name=Const_TradeDate'))).toBeLessThan(commands.findIndex(command=>command.includes('$name=em_csd_2')));
});
it.each([false,true])('EDB publish-date query, quota order and failed accounting withhold results (denied=%s)', async denied => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    const path = url.pathname; calls.push(path);
    if(path === '/api/count') expect(JSON.parse(String(init.body))).toEqual({subjectName:'EM_EDB',tokenID:'synthetic-token',num:'1'});
    return Response.json({code:200,data:[{flag:!(denied && path === '/api/count')}]});
  }));
  network.exchange.mockImplementation(async (endpoint: {port:number}, frame: Uint8Array) => {
    if(endpoint.port === 19) return syntheticLogin();
    expect(endpoint.port).toBe(6);
    const command = new TextDecoder().decode(frame.subarray(14));
    if(command.startsWith('$-EDBDATE')) { calls.push('publish'); return nativeFrame(fromHex(tables.edbPublish!)); }
    if(command.startsWith('$-edb')) { calls.push('values'); return nativeFrame(fromHex(tables.edb!)); }
    throw new Error('Unexpected synthetic EDB query');
  });
  const response = await createActor().fetch(new Request('https://choice.session.internal/query/edb',{method:'POST',body:JSON.stringify({edbIds:'EMM00000012',startDate:'2026-10-01',endDate:'2026-10-30',options:'IsPublishDate=1,FixDate=0'})}));
  expect(calls).toEqual(['/api/auth','publish','values','/api/auth','/api/count']);
  if(denied) {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error:{upstreamCode:10001012}});
  } else {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({function:'EDB',fields:['code','date','RESULT','PUBLISHDATE'],rows:[{code:'EMM00000012',date:'2026-10-30',RESULT:2.75,PUBLISHDATE:20261102}]});
  }
});
