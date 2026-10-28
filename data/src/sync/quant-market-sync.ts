import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { isChoiceError } from './choice-css-batch.ts';
import { EQUITY_CODES, EQUITY_FIELDS, VALUATION_FIELDS, SECONDARY_FIELDS, ISSUE_FIELDS, ISSUE_STAT_FIELDS,
  inputValue, sourceDate, type QuantInput } from './quant-input-contract.ts';

const tableSchema=z.object({function:z.string(),fields:z.array(z.string()),rows:z.array(z.record(z.string(),z.unknown()))});
export type QuantRequest={id:string;dataset:string;path:string;parameters:Record<string,string>;fields:string[];dateField:string;entityField?:string};
export function quantMarketRequests(startDate:string,endDate:string):QuantRequest[] {
  const range=`StartDate=${startDate},EndDate=${endDate}`;
  const specs:QuantRequest[] = [
    {id:'equity-close',dataset:'equity',path:'/choice/csd',parameters:{codes:EQUITY_CODES.join(','),indicators:'CLOSE',startDate,endDate,options:'Period=1,AdjustFlag=1,Order=1,FillData=0'},fields:['CLOSE'],dateField:'date'},
    {id:'equity-valuation',dataset:'equity',path:'/choice/csd',parameters:{codes:'800004.EI',indicators:Object.keys(VALUATION_FIELDS).join(','),startDate,endDate,
      options:'Period=1,AdjustFlag=1,Order=1,FillData=0,DelType=1,EquityER=1,BondER=1'},fields:Object.keys(VALUATION_FIELDS),dateField:'date'},
    {id:'secondary',dataset:'secondary',path:'/choice/ctr',parameters:{reportName:'BondTradingStatistics',indicators:['START_DATE','END_DATE',...SECONDARY_FIELDS].join(','),options:`${range},Frequency=1,Sum=1`},fields:SECONDARY_FIELDS,dateField:'START_DATE'},
    {id:'primary',dataset:'primary',path:'/choice/ctr',parameters:{reportName:'BondIssueStatistics',indicators:['START_DATE','END_DATE',...ISSUE_STAT_FIELDS].join(','),
      options:`${range},Bond_Type=-,Frequency=1,Issue_Date_Type=2,Tenor=-,Issuer_Rating=AAA,Bond_Rating=-,Region=-,Company_Type=-`},fields:ISSUE_STAT_FIELDS,dateField:'START_DATE'},
    {id:'issue',dataset:'issue',path:'/choice/ctr',parameters:{reportName:'BondIssueDetail',indicators:ISSUE_FIELDS.join(','),
      options:`${range},Bond_Type=646003,Frequency=1,Issuer_Rating=-,Bond_Rating=-,Issue_Date_Type=2,Tenor=-,Company_Type=-`},fields:ISSUE_FIELDS,dateField:'ISSUE_DATE',entityField:'SECUCODE'},
  ];
  return specs.flatMap(spec=>{
    if(spec.id!=='primary')return [spec];
    const days:QuantRequest[]=[];
    for(let date=startDate;date<=endDate;date=new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10)) {
      days.push({...spec,id:`primary-${date}`,parameters:{...spec.parameters,options:spec.parameters.options!.replace(range,`StartDate=${date},EndDate=${date}`)}});
    }
    return days;
  });
}

export async function fetchQuantMarketInputs(request:DataApiRequest,spec:QuantRequest,startDate:string,endDate:string):Promise<QuantInput[]> {
  let response:unknown;
  try { response=await request(spec.path,new URLSearchParams(spec.parameters)); }
  catch(error) {
    if(['primary','issue'].includes(spec.dataset) && isChoiceError(error,10000009))return [];
    throw error;
  }
  const payload=tableSchema.parse(response);
  if(payload.function!==(spec.path.endsWith('/csd')?'CSD':'CTR'))throw new Error('Unexpected Choice table');
  const hash=createHash('sha256').update(JSON.stringify(payload.rows)).digest('hex');
  const inputs:QuantInput[]=[];
  for(const raw of payload.rows) {
    const date=sourceDate(raw[spec.dateField]);
    if(!date)throw new Error(`Invalid ${spec.id} observation date`);
    if(date<startDate||date>endDate)continue;
    if(spec.dataset==='issue'&&!['证券公司债','证券公司次级债'].includes(String(raw.BOND_TYPE)))continue;
    if(['primary','secondary'].includes(spec.dataset)&&sourceDate(raw.END_DATE)!==date)throw new Error(`Non-daily ${spec.id} row`);
    const entity=spec.entityField?String(raw[spec.entityField]??''):'';
    if(spec.entityField&&!entity)throw new Error('Missing bond code');
    for(const field of spec.fields) {
      if(field==='ISSUE_DATE')continue;
      let target=field;
      if(spec.id==='equity-close') {
        const index=EQUITY_CODES.indexOf(String(raw.code));
        if(index<0)throw new Error('Unexpected equity code');
        target=EQUITY_FIELDS[index]!;
      }else if(spec.id==='equity-valuation'){
        if(raw.code!=='800004.EI')throw new Error('Unexpected valuation code');
        target=VALUATION_FIELDS[field]!;
      }
      const value=inputValue(spec.dataset,target,date,raw[field],'choice-api',spec.id,hash,entity);
      if(value)inputs.push(value);
    }
  }
  return inputs;
}

// Only missing spreads are requested. Invalid codes are isolated rather than
// retrying the full paid batch; other upstream errors remain failures.
export async function fetchIssueSpreads(request:DataApiRequest,bonds:Array<{code:string;date:string}>):Promise<{rows:QuantInput[];invalidCodes:string[]}> {
  if(!bonds.length)return {rows:[],invalidCodes:[]};
  let payload:z.infer<typeof tableSchema>;
  try {
    payload=tableSchema.parse(await request('/choice/css',new URLSearchParams({codes:bonds.map(x=>x.code).join(','),indicators:'ISSUECREDITSPREAD'})));
  }catch(error) {
    if(!/10003008|invalid stock code/i.test(String(error)))throw error;
    if(bonds.length===1)return {rows:[],invalidCodes:[bonds[0]!.code]};
    const middle=Math.ceil(bonds.length/2);
    const left=await fetchIssueSpreads(request,bonds.slice(0,middle));
    const right=await fetchIssueSpreads(request,bonds.slice(middle));
    return {rows:[...left.rows,...right.rows],invalidCodes:[...left.invalidCodes,...right.invalidCodes]};
  }
  if(payload.function!=='CSS')throw new Error('Unexpected spread table');
  const dates=new Map(bonds.map(x=>[x.code,x.date]));
  const hash=createHash('sha256').update(JSON.stringify(payload.rows)).digest('hex');
  const rows=payload.rows.flatMap(row=>{
    const code=String(row.code),date=dates.get(code);
    if(!date)return [];
    const value=inputValue('issue','ISSUECREDITSPREAD',date,row.ISSUECREDITSPREAD,'choice-api','issue-spread',hash,code);
    return value?[value]:[];
  });
  return {rows,invalidCodes:[]};
}
