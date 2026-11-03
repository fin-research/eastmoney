import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { ChoiceReader, ChoiceWireError, decodeChoiceScalar, decodeChoiceSheets, encodeChoiceFrame, decodeChoiceHeader, choiceCodesCommand, choiceTradeDatesCommand } from "../src/choice/native/wire.ts";
import { applyPercent, calendarQueryForCsd, decodeQuery, encodeQuery } from "../src/choice/native/query.ts";
const hexFixtures:Record<string,string> = JSON.parse(readFileSync(new URL("./fixtures/choice-native/sdk-table-fixtures.json",import.meta.url),"utf8"));
const fixture=(name:string)=>new Uint8Array(Buffer.from(hexFixtures[name]!,"hex"));
test("actual SDK pure decoder accepts the retained sheet fixture layouts",()=>{
  const sheet=decodeChoiceSheets(fixture("css"))[0]!;
  assert.deepEqual(sheet,{name:"CLOSE",columns:["code","value"],types:[4,7],rows:[["000001.SH",12.5]]});
});
test("all recovered query table shapes map to the existing Choice table contract",()=>{
  assert.deepEqual(decodeQuery("css",{codes:"000001.SH",indicators:"CLOSE"},fixture("css")),{function:"CSS",fields:["code","CLOSE"],rows:[{code:"000001.SH",CLOSE:12.5}]});
  assert.deepEqual(decodeQuery("csd",{codes:"000001.SH",indicators:"CLOSE"},fixture("csd3")),{function:"CSD",fields:["code","date","CLOSE"],rows:[{code:"000001.SH",date:"2026-10-30",CLOSE:12.5}]});
  assert.deepEqual(decodeQuery("edb",{},fixture("edb")),{function:"EDB",fields:["code","date","RESULT"],rows:[{code:"EMM0001",date:"2026-10-30",RESULT:2.75}]});
  assert.deepEqual(decodeQuery("tradedates",{},fixture("tradedates")),{function:"TRADEDATES",fields:["date"],rows:[{date:"2026-10-30"}]});
  assert.deepEqual(decodeQuery("ctr",{},fixture("ctr")),{function:"CTR",fields:["NAME","COUNT"],rows:[{NAME:"example",COUNT:4}]});
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
  assert.throws(()=>encodeQuery("edb",{edbIds:"EMM0001",startDate:"2026-10-01",endDate:"2026-10-30",options:"FIXDATE=1"},"token","id"),ChoiceWireError);
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
