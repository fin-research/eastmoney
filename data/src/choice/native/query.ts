import { ChoiceWireError, choiceCsdCommand, choiceCssCommand, choiceTradeDatesCommand, encodeChoiceFrame, decodeChoiceSheets, MAX_OUTPUT_ROWS, MAX_OUTPUT_CELLS, type ChoiceScalar } from "./wire.ts";
export interface ChoiceTable { function: "CSD" | "CSS" | "CTR" | "EDB" | "DATASTATISTICS" | "TRADEDATES"; fields: string[]; rows: Array<Record<string, unknown>>; }
export interface EncodedChoiceQuery { serverType: number; frame: Uint8Array; }
function text(payload: Record<string, unknown>, key: string, fallback = ""): string {
  const value = payload[key] ?? fallback;
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new ChoiceWireError(`Invalid Choice ${key}`);
  return value;
}
function csv(value: string): string[] { const parts=value.split(","); if(parts.length>MAX_OUTPUT_ROWS) throw new ChoiceWireError("Choice item count exceeds limit"); return parts.map(item=>item.trim().toUpperCase()).filter(Boolean); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+"T00:00:00Z")) || new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value) throw new ChoiceWireError("Only explicit ISO dates are supported by native Choice");
  return value;
}
function options(payload: Record<string, unknown>): Map<string,string> {
  const result = new Map<string,string>();
  for (const part of text(payload,"options").split(",")) {
    if (!part.trim()) continue;
    const index=part.indexOf("=");
    if (index <= 0) throw new ChoiceWireError("Invalid Choice option");
    const key=part.slice(0,index).trim().toUpperCase(), value=part.slice(index+1).trim();
    if (["TOKEN","SESSIONID","USERID"].includes(key) || /[|$()]/.test(part)) throw new ChoiceWireError("Reserved Choice option");
    if (key !== "ISPANDAS") result.set(key,value);
  }
  return result;
}
function serializeOptions(value: Map<string,string>): string { return [...value].map(([key,item])=>key+"="+item).join(","); }
/** Caller owns sessions, quotas, timeout and TCP exchange. */
export function encodeQuery(functionName: string, payload: Record<string, unknown>, token: string, uid: string): EncodedChoiceQuery {
  if (/[\r\n\0,|$()]/.test(token+uid)) throw new ChoiceWireError("Invalid Choice authentication material");
  const opt=options(payload), optionString=serializeOptions(opt);
  const indicators=text(payload,"indicators");
  const codes=unique(csv(text(payload,"codes")));
  let command: string, serverType=3;
  switch(functionName.toLowerCase()) {
    case "csd": validateCsdOptions(opt); command=choiceCsdCommand({codes,indicators,options:optionString,token,requestId:crypto.randomUUID(),startDate:date(text(payload,"startDate")),endDate:date(text(payload,"endDate"))});break;
    case "css": command=choiceCssCommand({codes,indicators,options:optionString,token,requestId:crypto.randomUUID()});break;
    case "tradedates": {
      const period=opt.get("PERIOD") ?? "1",order=opt.get("ORDER") ?? "1",market=opt.get("MARKET") ?? "CNSESH";
      if (!/^[1-5]$/.test(period) || !/^[12]$/.test(order) || !/^[A-Z0-9]+$/.test(market)) throw new ChoiceWireError("Unsupported Choice calendar option");
      command=choiceTradeDatesCommand({startDate:date(text(payload,"startDate")),endDate:date(text(payload,"endDate")),period,order:order as "1"|"2",market});break;
    }
    case "ctr": {
      serverType=20;
      const securityCode=opt.get("SECUCODE") ?? "";

      const reportName=text(payload,"reportName");
      if (!/^[A-Za-z0-9_]+$/.test(reportName)) throw new ChoiceWireError("Invalid Choice report name");
      command="$-api\r\n$name=em_ctr\r\n$secucode="+securityCode+"\r\n$subfname="+reportName+","+serializeOptions(opt)+(securityCode ? "" : ",secucode=")+",token="+token+",datacodes="+reportName;
      break;
    }
    case "edb": {
      serverType=6;
      command=edbCommand(payload,uid,false);
      break;
    }
    default: throw new ChoiceWireError(`Unsupported native Choice function ${functionName}`);
  }
  return {serverType,frame:encodeChoiceFrame(command)};
}
function normalizeDate(value: unknown): string {
  if (typeof value !== "string") throw new ChoiceWireError("Invalid Choice row date");
  // Choice sends unpadded dates such as 2026/11/2.
  const parts=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.split(" ",1)[0]!);
  const result=parts && `${parts[1]}-${parts[2]!.padStart(2,"0")}-${parts[3]!.padStart(2,"0")}`;
  if (!result || !(Date.parse(`${result}T00:00:00Z`)>0) || new Date(`${result}T00:00:00Z`).toISOString().slice(0,10)!==result) throw new ChoiceWireError("Unsupported Choice row date");
  return result;
}
function fields(source: readonly string[]): string[] {
  const count=new Map<string,number>();
  return source.map((item,index)=>{
    const key=item.trim().toUpperCase() || "FIELD_"+(index+1), n=(count.get(key) ?? 0)+1;
    count.set(key,n);return n===1?key:key+"_"+n;
  });
}
/** cquantstaticfunc::dealpercent @0x2a32be, before adapter rounding.
 * Flags come from actual EM_API_PERCENTFLAG + per-code STYPE metadata.
 * This function deliberately contains no indicator-name or market guesses.
 */
export function applyPercent(value: ChoiceScalar, wireType: number, flagged: boolean): ChoiceScalar {
  if (!flagged || value === null) return value;
  if (typeof value === "bigint") return wireType===10 ? BigInt.asIntN(64,value*100n) : wireType===14 ? BigInt.asUintN(64,value*100n) : value;
  if (typeof value !== "number") return value;
  switch(wireType) {
    case 6: case 7: return value*100;
    case 8: return Math.fround(value*100);
    case 9: return Math.imul(value,100);
    case 11: return (value*100 <<16)>>16;
    case 13: return Math.imul(value,100)>>>0;
    case 15: return value*100 & 65535;
    default: return value;
  }
}
export type ChoicePercentIndicatorsByCode = Readonly<Record<string, readonly string[]>>;
function publicScalar(value: ChoiceScalar, wireType: number): unknown {
  if (wireType===1 || wireType===2) return null; // Existing C++ adapter intentionally drops byte/byte-array.
  if (typeof value === "bigint") return Number(value); // Existing JSON boundary parsed into JS numbers.
  if (typeof value === "number" && [6,7,8].includes(wireType)) { const rounded=Math.sign(value)*Math.round(Math.abs(value)*1_000_000)/1_000_000; return Number.isFinite(rounded)?rounded:null; }
  return value;
}
function scalarText(value: ChoiceScalar|undefined): string {
  if (typeof value !== "string") throw new ChoiceWireError("Invalid Choice row key");
  return value;
}
export function decodeQuery(functionName: string,payload: Record<string,unknown>,responseBody: Uint8Array, expectedDates?: readonly string[], percentIndicatorsByCode?: ChoicePercentIndicatorsByCode, publishDatesBody?: Uint8Array): ChoiceTable {
  const name=functionName.toUpperCase(), sheets=decodeChoiceSheets(responseBody);
  if (name === "TRADEDATES") {
    for (const sheet of sheets) if (sheet.types.length!==1 || sheet.types[0]!==5) throw new ChoiceWireError("Invalid Choice calendar schema");
    return {function:"TRADEDATES",fields:["date"],rows:sheets.flatMap(sheet=>sheet.rows.map(row=>({date:normalizeDate(row[0])})))};
  }
  if (name === "CTR") {
    if (sheets.length > 1) throw new ChoiceWireError("Multiple Choice CTR sheets need explicit mapping");
    const sheet=sheets[0]; if (!sheet) return {function:"CTR",fields:[],rows:[]};
    const requested=unique(csv(text(payload,"indicators").replaceAll("|",",")));
    const projected=requested.map(field=>sheet.columns.findIndex(column=>column.toUpperCase()===field)).filter(index=>index>=0);
    const columns=projected.length ? projected : sheet.columns.map((_,index)=>index);
    const outputFields=fields(columns.map(index=>sheet.columns[index]!));
    return {function:"CTR",fields:outputFields,rows:sheet.rows.map(row=>Object.fromEntries(outputFields.map((field,index)=>[field,publicScalar(row[columns[index]!]!,sheet.types[columns[index]!]!)])))};
  }
  if (name !== "CSD" && name !== "CSS" && name !== "EDB") throw new ChoiceWireError("Unsupported native Choice response function");
  if (name === "EDB") {
    const publish=options(payload).get("ISPUBLISHDATE") === "1" && edbIdType(csv(text(payload,"edbIds")).length ? csv(text(payload,"edbIds")) : sheets.map(sheet=>sheet.name.toUpperCase()))===1;
    if(publish && !publishDatesBody) throw new ChoiceWireError("Choice EDB publish dates response is required");
    const publishValues=new Map<string,number|null>();
    if(publishDatesBody) for(const sheet of decodeChoiceSheets(publishDatesBody)) {
      if(sheet.columns.length!==2 || sheet.types[1]!==7) throw new ChoiceWireError("Invalid Choice EDB publish schema");
      for(const row of sheet.rows){
        const key=sheet.name.toUpperCase()+"\0"+normalizeDate(row[0]);
        const value=row[1];
        if(!publishValues.has(key)) publishValues.set(key,typeof value === "number" ? Math.trunc(value)|0 : null);
      }
    }
    const values=new Map<string,Record<string,unknown>>(),seen=new Set<string>();
    const requestedIds=csv(text(payload,"edbIds"));
    for (const sheet of sheets) {
      const code=sheet.name.toUpperCase();
      if (sheet.columns.length!==2 || sheet.types[1]!==7 || (requestedIds.length && !requestedIds.includes(code))) throw new ChoiceWireError("Invalid Choice EDB schema");
      for (const row of sheet.rows) {
        const day=normalizeDate(row[0]),key=code+"\0"+day;
        if(seen.has(key))continue; // SDK std::map::insert keeps the first row.
        seen.add(key);
        const value=publicScalar(row[1]!,sheet.types[1]!);
        const published=publishValues.get(key) ?? null;
        if (value !== null || (publish && published !== null)) values.set(key,{code,date:day,RESULT:value,...(publish?{PUBLISHDATE:published}:{})});
      }
    }
    const rows=[...values.values()];
    rows.sort((a,b)=>String(a.code).localeCompare(String(b.code)) || String(a.date).localeCompare(String(b.date)));
    return {function:"EDB",fields:["code","date","RESULT",...(publish?["PUBLISHDATE"]:[])],rows};
  }
  const requestedIndicators=csv(text(payload,"indicators")),requestedCodes=unique(csv(text(payload,"codes")));
  const outputIndicators=fields(requestedIndicators.length ? requestedIndicators : sheets.map(sheet=>sheet.name));
  const indicatorIndex=new Map((requestedIndicators.length ? requestedIndicators : sheets.map(sheet=>sheet.name.toUpperCase())).map((field,index)=>[field,index]));
  const observedCodes:string[]=[],observedDates:string[]=[];
  const values=new Map<string,unknown>();
  for (const sheet of sheets) {
    if (sheet.columns.length !== (name === "CSD"?3:2)) throw new ChoiceWireError("Invalid Choice sequence schema");
    const sheetIndicator=(name === "CSD" ? sheet.name.slice(0,sheet.name.lastIndexOf("#")<0?undefined:sheet.name.lastIndexOf("#")) : sheet.name).toUpperCase();
    const index=indicatorIndex.get(sheetIndicator);
    if (index === undefined) continue;
    for (const row of sheet.rows) {
      const code=scalarText(row[0]).toUpperCase(), day=name === "CSD"?normalizeDate(row[1]):"";
      observedCodes.push(code);if (day) observedDates.push(day);
      const column=name === "CSD"?2:1;
      values.set(code+"\0"+day+"\0"+index,publicScalar(applyPercent(row[column]!,sheet.types[column]!,percentIndicatorsByCode?.[code]?.includes(sheetIndicator) ?? false),sheet.types[column]!));
    }
  }
  const outputCodes=requestedCodes.length?requestedCodes:unique(observedCodes);
  if (expectedDates && expectedDates.length>MAX_OUTPUT_ROWS) throw new ChoiceWireError("Choice calendar count exceeds limit");
  const outputDates=name === "CSD"?(expectedDates === undefined ? unique(observedDates).sort() : unique(expectedDates.map(normalizeDate)).sort()):[""];
  if (outputCodes.length * outputDates.length > MAX_OUTPUT_ROWS || outputCodes.length * outputDates.length * Math.max(outputIndicators.length,1) > MAX_OUTPUT_CELLS) throw new ChoiceWireError("Choice output matrix exceeds limit");
  const rows:Array<Record<string,unknown>>=[];
  for(const code of outputCodes) for(const day of outputDates) {
    const row:Record<string,unknown>={code,...(name === "CSD"?{date:day}:{})};
    outputIndicators.forEach((field,index)=>{row[field]=values.get(code+"\0"+day+"\0"+index) ?? null;});rows.push(row);
  }
  return {function:name,fields:["code",...(name === "CSD"?["date"]:[]),...outputIndicators],rows};
}

function validateCsdOptions(opt: Map<string,string>): void {
  if ((opt.get("PERIOD") ?? "1") !== "1" || (opt.get("FILLDATA") ?? "0") !== "0" || ["0","1"].includes(opt.get("MARKET") ?? "")) throw new ChoiceWireError("Native CSD supports daily trading-calendar queries with FillData=0 only");
}
/** SDK ccsd3::checkparams @0x29fb23 uses a TRADEDATES request before CSD.
 * Market=0/1, non-daily periods and FillData=1 have additional local transforms.
 */
export function calendarQueryForCsd(payload: Record<string,unknown>): Record<string,unknown> {
  const opt=options(payload), period=opt.get("PERIOD") ?? "1", market=opt.get("MARKET") ?? "CNSESH";
  validateCsdOptions(opt);
  return {startDate:date(text(payload,"startDate")),endDate:date(text(payload,"endDate")),options:"PERIOD="+period+",ORDER="+(opt.get("ORDER") ?? "1")+",MARKET="+market};
}

function edbCommand(payload: Record<string,unknown>,uid:string,publish:boolean):string {
  const ids=csv(text(payload,"edbIds"));
  const idType=edbIdType(ids);
  if(/[\r\n\0,|$()]/.test(uid))throw new ChoiceWireError("Invalid Choice EDB UID");
  for(const [key,value] of options(payload)) {
    if(["STARTDATE","ENDDATE"].includes(key))continue;
    if((key==="FIXDATE" || key==="ISLATEST") && value==="0")continue;
    if(key==="ISPUBLISHDATE" && ["0","1"].includes(value))continue;
    throw new ChoiceWireError(`Unsupported native EDB option ${key}`);
  }
  return "$-"+(publish?"EDBDATE":idType===1?"edb":"bond")+"\r\n$indicate(userid="+uid+"|name="+ids.join(",")+"|startDate="+date(text(payload,"startDate"))+"|enddate="+date(text(payload,"endDate"))+"|CLIENT=CHOICEPC)";
}
/** cedbwraper @0x2aca8e performs this query before EDB when IsPublishDate=1. */
export function publishDateQueryForEdb(payload:Record<string,unknown>,uid:string):EncodedChoiceQuery|undefined {
  if(options(payload).get("ISPUBLISHDATE")!=="1" || edbIdType(csv(text(payload,"edbIds")))!==1)return undefined;
  return {serverType:6,frame:encodeChoiceFrame(edbCommand(payload,uid,true))};
}

function edbIdType(ids:readonly string[]):1|2 {
  if(!ids.length)throw new ChoiceWireError("Choice EDB IDs are required");
  const types=ids.map(id=>/^EM[IMGW]\d{8}$/.test(id)?1:/^E\d{7}$/.test(id)?2:0);
  if(types.some(type=>type===0 || type!==types[0])) throw new ChoiceWireError("Choice EDB IDs have unsupported or mixed formats");
  return types[0] as 1|2;
}
