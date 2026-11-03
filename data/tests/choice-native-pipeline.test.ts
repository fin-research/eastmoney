import { readFileSync } from 'node:fs';
import { expect, it, vi, afterEach } from 'vitest';
const network = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }));
vi.mock('../src/choice/native/transport', async importOriginal => {
  const original = await importOriginal<typeof import('../src/choice/native/transport')>();
  return { ...original, exchange: network.exchange, ChoiceConnection: class {
    async deadline<T>(operation: () => Promise<T>) { return operation(); }
    async send() {}
    async close() {}
    async receive() { const header = new Uint8Array(13); new DataView(header.buffer).setUint32(1,13,true); header[6] = 100; return {header, body: new Uint8Array()}; }
  } };
});
vi.mock('cloudflare:sockets', () => ({ connect: () => { throw new Error('Real sockets forbidden'); } }));
import { ChoiceSession } from '../src/choice/native/session';
const tables: Record<string,string> = JSON.parse(readFileSync(new URL('./fixtures/choice-native/sdk-table-fixtures.json',import.meta.url),'utf8'));
const quota: {percent:string} = JSON.parse(readFileSync(new URL('./fixtures/choice-native/quota-fixtures.json',import.meta.url),'utf8'));
const fromHex = (hex:string) => new Uint8Array(Buffer.from(hex,'hex'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('runs native CSS metadata and SDK table decoding and reuses metadata for the next query', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real HTTP forbidden'); }));
  const commands: string[] = [];
  network.exchange.mockImplementation(async (endpoint: {port:number}, frame: Uint8Array) => {
    const header = new Uint8Array(13);
    if (endpoint.port === 19) return {header,body:new TextEncoder().encode(JSON.stringify({Code:0,Data:{BaseInfo:{UniqueId:'fixture',Token:'synthetic-token',SessionID:'synthetic-session',Ctoken:'synthetic-ctoken',Utoken:'synthetic-utoken'}}}))};
    const command = new TextDecoder().decode(frame.subarray(14)); commands.push(command);
    if (command.includes('$name=EM_API_PERCENTFLAG')) return {header,body:fromHex(quota.percent)};
    if (command.includes('$name=Code_Type')) return {header,body:new Uint8Array(readFileSync(new URL('./fixtures/choice-native/codeinfo.bin',import.meta.url)))};
    if (command.includes('$name=em_css')) return {header,body:fromHex(tables.cssPct!)};
    throw new Error('Unexpected synthetic query');
  });
  const values = new Map<string,unknown>();
  const storage = {get:async(key:string)=>values.get(key), put:async(key:string,value:unknown)=>{values.set(key,value);},delete:async(key:string)=>values.delete(key),setAlarm:async()=>{},deleteAlarm:async()=>{}};
  const servers = Object.fromEntries(['2','3','6','19','20'].map(type=>[type,{hostname:'synthetic.invalid',port:Number(type)}]));
  const env = {CHOICE_SERVERS:JSON.stringify({...servers,statisticsOrigin:'https://synthetic.invalid/'}),CHOICE_CREDENTIALS:JSON.stringify({mode:'auto',uid:'fixture',ctoken:'synthetic',utoken:'synthetic',deviceId:'synthetic',deviceModel:'MACMD5'}),CHOICE_OTHER_LIMIT:{limit:async()=>({success:true})}} as unknown as Cloudflare.Env;
  const session = new ChoiceSession({storage} as unknown as DurableObjectState,env);
  const request=()=>new Request('https://choice.session.internal/query/css',{method:'POST',body:JSON.stringify({codes:'000001.SH',indicators:'PCT'})});
  for(let i=0;i<2;i++) {
    const response=await session.fetch(request());expect(response.status, JSON.stringify({commands, calls:network.exchange.mock.calls.map(([endpoint])=>endpoint)})).toBe(200);
    expect(await response.json()).toEqual({function:'CSS',fields:['code','PCT'],rows:[{code:'000001.SH',PCT:1250}]});
  }
  expect(commands.filter(command=>command.includes('$name=EM_API_PERCENTFLAG'))).toHaveLength(1);
  expect(commands.filter(command=>command.includes('$name=Code_Type'))).toHaveLength(1);
  expect(commands.filter(command=>command.includes('$name=em_css'))).toHaveLength(2);
});
