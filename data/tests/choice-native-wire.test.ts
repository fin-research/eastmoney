import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { ChoiceReader, ChoiceWireError, ChoiceServerError, assertQueryFrame, decodeChoiceScalar, decodeChoiceSheets, encodeChoiceFrame, decodeChoiceHeader, choiceCodesCommand, choiceTradeDatesCommand, choiceCssCommand, choiceCsdCommand } from "../src/choice/native/wire.ts";
import { applyPercent, calendarQueryForCsd, publishDateQueryForEdb, decodeQuery, encodeQuery } from "../src/choice/native/query.ts";
const hexFixtures:Record<string,string> = JSON.parse(readFileSync(new URL("./fixtures/choice-native/sdk-table-fixtures.json",import.meta.url),"utf8"));
const fixture=(name:string)=>new Uint8Array(Buffer.from(hexFixtures[name]!,"hex"));
test("actual SDK pure decoder accepts the retained sheet fixture layouts",()=>{
  const sheet=decodeChoiceSheets(fixture("css"))[0]!;
  assert.deepEqual(sheet,{name:"CLOSE",columns:["code","value"],types:[4,7],rows:[["000001.SH",12.5]]});
});
test("all recovered query table shapes map to the existing Choice table contract",()=>{
  assert.deepEqual(decodeQuery("css",{codes:"000001.SH",indicators:"CLOSE"},fixture("css")),{function:"CSS",fields:["code","CLOSE"],rows:[{code:"000001.SH",CLOSE:12.5}]});
  assert.deepEqual(decodeQuery("csd",{codes:"000001.SH",indicators:"CLOSE"},fixture("csd3")),{function:"CSD",fields:["code","date","CLOSE"],rows:[{code:"000001.SH",date:"2026-10-30",CLOSE:12.5}]});
  assert.deepEqual(decodeQuery("edb",{},fixture("edb")),{function:"EDB",fields:["code","date","RESULT"],rows:[{code:"EMM00000012",date:"2026-10-30",RESULT:2.75}]});
  assert.deepEqual(decodeQuery("tradedates",{},fixture("tradedates")),{function:"TRADEDATES",fields:["date"],rows:[{date:"2026-10-30"}]});
  assert.deepEqual(decodeQuery("ctr",{},fixture("ctr")),{function:"CTR",fields:["NAME","COUNT"],rows:[{NAME:"example",COUNT:4}]});
});
test("row dates accept the unpadded Choice form and reject impossible dates",()=>{
  const payload={codes:"000001.SH",indicators:"CLOSE"};
  assert.deepEqual(decodeQuery("csd",payload,fixture("csd3"),["2026/10/30"]).rows,[{code:"000001.SH",date:"2026-10-30",CLOSE:12.5}]);
  assert.deepEqual(decodeQuery("csd",payload,fixture("csd3"),["2026/1/5"]).rows.map(row=>row.date),["2026-01-05"]);
  assert.throws(()=>decodeQuery("csd",payload,fixture("csd3"),["2026/13/45"]),/Unsupported Choice row date/);
  assert.throws(()=>decodeQuery("csd",payload,fixture("csd3"),["2026/2/30"]),/Unsupported Choice row date/);
});
test("several indicators are pipe separated because the comma separates options",()=>{
  const base={codes:["000001.SH"],options:"TradeDate=2026-11-03,EndDate=2026-11-03",token:"token",requestId:"id"};
  assert.equal(choiceCssCommand({...base,indicators:"CLOSE, PRECLOSE,MV"}),"$-api\r\n$name=em_css\r\n$secucode=000001.SH\r\n$subfname=CLOSE|PRECLOSE|MV,TradeDate=2026-11-03,EndDate=2026-11-03,token=token,SessionId=id");
  assert.equal(choiceCssCommand({...base,indicators:"CLOSE"}).includes("$subfname=CLOSE,TradeDate"),true);
  assert.equal(choiceCsdCommand({...base,indicators:"CLOSE,OPEN",startDate:"2026-11-02",endDate:"2026-11-03"}).includes("$subfname=CLOSE|OPEN,StartDate=2026-11-02,EndDate=2026-11-03,"),true);
});
test("request framing matches recovered little-endian 14-byte SDK header",()=>{
  assert.deepEqual([...encodeChoiceFrame("X")],[0,15,0,0,0,1,250,0,0,0,0,0,0,5,88]);
  assert.equal(choiceCodesCommand(["000001.SH","600000.SH"]),"$secucode=000001.SH,600000.SH\r\n");
  assert.equal(choiceTradeDatesCommand({startDate:"2026-10-01",endDate:"2026-10-30",period:"1",order:"1",market:"CNSESH"}),"$-rpt\r\n$name=Const_TradeDate\r\n$StartDate=2026-10-01,EndDate=2026-10-30,DataType=1,PERIOD=1,DESC=ESC,TEXCH=CNSESH");
  const header=new Uint8Array(13);new DataView(header.buffer).setUint32(1,18,true);header[7]=2;header[9]=1;
  assert.deepEqual(decodeChoiceHeader(header),{length:18,type:1,compression:2});
});
test("bounded varints and SDK numeric null sentinels",()=>{
  const reader=new ChoiceReader(Uint8Array.of(0xac,0x02));assert.equal(reader.varint(),300);assert.equal(reader.position,2);
  assert.throws(()=>new ChoiceReader(Uint8Array.of(0x80)).varint(),ChoiceWireError);
  assert.throws(()=>new ChoiceReader(Uint8Array.of(255,255,255,255,31)).varint(),ChoiceWireError);
  const buf=new Uint8Array(4);new DataView(buf.buffer).setInt32(0,2147483647,true);assert.equal(decodeChoiceScalar(new ChoiceReader(buf),9),null);
  new DataView(buf.buffer).setInt32(0,-2147483648,true);assert.equal(decodeChoiceScalar(new ChoiceReader(buf),9),null);
  const decimal=new Uint8Array(16);const view=new DataView(decimal.buffer);view.setUint32(0,123,true);view.setUint32(12,0x80020000,true);assert.equal(decodeChoiceScalar(new ChoiceReader(decimal),6),-1.23);
});
test("malformed sheets, control injection, and unsupported EDB options fail closed",()=>{
  for(let n=0;n<fixture("css").length;n++) if(n!==8) assert.throws(()=>decodeChoiceSheets(fixture("css").subarray(0,n)),ChoiceWireError);
  assert.throws(()=>encodeQuery("css",{codes:"000001.SH\r\n$INJECT",indicators:"CLOSE"},"token","id"),ChoiceWireError);
  assert.throws(()=>encodeQuery("edb",{edbIds:"EMM00000012",startDate:"2026-10-01",endDate:"2026-10-30",options:"FIXDATE=1"},"token","id"),ChoiceWireError);
});
test("CSD preserves the queried calendar grid including completely missing dates",()=>{
 const result=decodeQuery("csd",{codes:"000001.SH,600000.SH",indicators:"CLOSE"},fixture("csd3"),["2026-10-29","2026-10-30"]);
 assert.deepEqual(result.rows,[{code:"000001.SH",date:"2026-10-29",CLOSE:null},{code:"000001.SH",date:"2026-10-30",CLOSE:12.5},{code:"600000.SH",date:"2026-10-29",CLOSE:null},{code:"600000.SH",date:"2026-10-30",CLOSE:null}]);
});

test("public CSD3 command and CTR selection match direct SDK request probes",()=>{
 const csd=encodeQuery("csd",{codes:"000001.SH",indicators:"CLOSE",startDate:"2026-10-01",endDate:"2026-10-30"},"token","uid");
 assert.match(new TextDecoder().decode(csd.frame.subarray(14)),/^\$-api\r\n\$name=em_csd_2\r\n/);
 const ctr=(options:string)=>new TextDecoder().decode(encodeQuery("ctr",{reportName:"Report_Name",indicators:"COUNT",options},"token","uid").frame.subarray(14));
 assert.equal(ctr(""),"$-api\r\n$name=em_ctr\r\n$secucode=\r\n$subfname=Report_Name,,secucode=,token=token,datacodes=Report_Name");
 assert.equal(ctr("SECUCODE=000001.SH"),"$-api\r\n$name=em_ctr\r\n$secucode=000001.SH\r\n$subfname=Report_Name,SECUCODE=000001.SH,token=token,datacodes=Report_Name");
 assert.deepEqual(calendarQueryForCsd({startDate:"2026-10-01",endDate:"2026-10-30"}),{startDate:"2026-10-01",endDate:"2026-10-30",options:"PERIOD=1,ORDER=1,MARKET=CNSESH"});
 assert.throws(()=>calendarQueryForCsd({startDate:"2026-10-01",endDate:"2026-10-30",options:"PERIOD=2"}),ChoiceWireError);
});
test("percentage flags are explicit and scale before public rounding",()=>{
 assert.equal(applyPercent(0.123456789,7,true),12.3456789);
 assert.equal(applyPercent(12.5,7,false),12.5);
 assert.equal(applyPercent(327,11,true),32700);
 const result=decodeQuery("css",{codes:"000001.SH",indicators:"CLOSE"},fixture("css"),undefined,{"000001.SH":["CLOSE"]});
 assert.equal(result.rows[0]?.CLOSE,1250);
});
test("sparse CSD grids and oversized calendars fail before row expansion",()=>{
 const payload={codes:Array.from({length:1000},(_,i)=>"C"+i).join(","),indicators:"CLOSE"};
 const dates=Array.from({length:1000},(_,i)=>new Date(Date.UTC(2023,0,1+i)).toISOString().slice(0,10));
 assert.throws(()=>decodeQuery("csd",payload,fixture("csd3"),dates),/matrix exceeds limit/);
 assert.throws(()=>decodeQuery("csd",{codes:"A",indicators:"CLOSE"},fixture("csd3"),Array(100001).fill("2026-10-30")),/calendar count exceeds limit/);
 assert.throws(()=>encodeQuery("csd",{codes:"A",indicators:"CLOSE",startDate:"2026-02-30",endDate:"2026-10-30"},"token","uid"),ChoiceWireError);
});

test("EDB publish-date merge matches actual SDK wrapper with offline response injection",()=>{
 const payload={edbIds:"EMM00000012",startDate:"2026-10-01",endDate:"2026-10-30",options:"IsPublishDate=1,FixDate=0"};
 assert.doesNotThrow(()=>encodeQuery("edb",payload,"token","uid"));
 const extra=publishDateQueryForEdb(payload,"uid")!;
 assert.equal(extra.serverType,6);
 assert.equal(new TextDecoder().decode(extra.frame.subarray(14)),"$-EDBDATE\r\n$indicate(userid=uid|name=EMM00000012|startDate=2026-10-01|enddate=2026-10-30|CLIENT=CHOICEPC)");
 assert.throws(()=>decodeQuery("edb",payload,fixture("edb")),/publish dates response is required/);
 assert.deepEqual(decodeQuery("edb",payload,fixture("edb"),undefined,undefined,fixture("edbPublish")),{function:"EDB",fields:["code","date","RESULT","PUBLISHDATE"],rows:[{code:"EMM00000012",date:"2026-10-30",RESULT:2.75,PUBLISHDATE:20261102}]});
});

test("legacy EDB route and ignored publish option match actual SDK wrapper",()=>{
 const payload={edbIds:"E1000172",startDate:"2026-10-01",endDate:"2026-10-30",options:"IsPublishDate=1,FixDate=0"};
 const query=encodeQuery("edb",payload,"token","uid");
 assert.equal(query.serverType,6);
 assert.equal(new TextDecoder().decode(query.frame.subarray(14)),"$-bond\r\n$indicate(userid=uid|name=E1000172|startDate=2026-10-01|enddate=2026-10-30|CLIENT=CHOICEPC)");
 assert.equal(publishDateQueryForEdb(payload,"uid"),undefined);
 assert.deepEqual(decodeQuery("edb",payload,fixture("edbLegacy")),{function:"EDB",fields:["code","date","RESULT"],rows:[{code:"E1000172",date:"2026-10-30",RESULT:2.75}]});
 assert.throws(()=>encodeQuery("edb",{...payload,edbIds:"E1000172,EMM00000012"},"token","uid"),ChoiceWireError);
});
test("CTR projects known indicators locally and falls back when none match SDK columns",()=>{
 assert.deepEqual(decodeQuery("ctr",{indicators:"COUNT,NAME,UNKNOWN,COUNT"},fixture("ctr")),{function:"CTR",fields:["COUNT","NAME"],rows:[{COUNT:4,NAME:"example"}]});
 assert.deepEqual(decodeQuery("ctr",{indicators:"UNKNOWN"},fixture("ctr")),{function:"CTR",fields:["NAME","COUNT"],rows:[{NAME:"example",COUNT:4}]});
});
test("query error statuses preserve SDK numeric error codes without vendor text",()=>{
 const frame=(status:number,text:string)=>{const header=new Uint8Array(13);new DataView(header.buffer).setUint32(1,13+text.length,true);header[9]=status;return {header,body:new TextEncoder().encode(text)};};
 for(const [status,text,code] of [[101,"secret",10002003],[102,"secret",10000015],[107,"secret",10000013],[103,"secret [10000]",10001012],[103,"secret [10001]",10001012],[103,"secret [10002]",10000016],[103,"secret [10003]",10003010],[103,"secret [10004]",10000013]] as const) {
   assert.throws(()=>assertQueryFrame(frame(status,text)),error=>error instanceof ChoiceServerError && error.upstreamCode===code && !error.message.includes("secret"));
 }
 assert.doesNotThrow(()=>assertQueryFrame(frame(1,"")));
});
