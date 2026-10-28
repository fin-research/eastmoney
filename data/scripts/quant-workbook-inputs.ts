import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { FUNDING_FIELDS, FUNDING_EDB, EQUITY_FIELDS, VALUATION_FIELDS,
  SECONDARY_FIELDS, inputValue, sourceDate, type QuantInput } from '../src/sync/quant-input-contract.ts';
import type { EconomicIndicatorSyncRow } from '../src/sync/economic-indicators-repository.ts';

type Cell = string | number | null;
type Matrix = Cell[][];
const excelDate = (value: Cell | undefined): string | null => {
  if (typeof value === 'number' && value > 30000 && value < 70000) {
    const d = XLSX.SSF.parse_date_code(value);
    return d ? `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}` : null;
  }
  return sourceDate(value);
};

export async function readQuantWorkbooks(directory: string, endDate: string) {
  const inputs: QuantInput[] = [], edb: EconomicIndicatorSyncRow[] = [];
  const manifest: Array<{sourceKey: string; sourceHash: string; rows: number}> = [];
  async function workbook(file: string) {
    const bytes = await readFile(path.join(directory, file));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const book = XLSX.read(bytes, {cellDates:false});
    return {hash, sheet(name?: string): Matrix {
      const selected = book.Sheets[name ?? book.SheetNames[0]!]!;
      if (!selected) throw new Error(`Missing sheet ${file}/${name}`);
      return XLSX.utils.sheet_to_json(selected, {header:1, defval:null});
    }};
  }
  function add(dataset: string, field: string, date: string, value: unknown, file: string, hash: string, entity = '') {
    if (date > endDate) return;
    const row = inputValue(dataset,field,date,value,'local-workbook',file,hash,entity);
    if (row) inputs.push(row);
  }
  const market = await workbook('data.xlsx');
  const funding = market.sheet('资金面数据');
  if (funding[1]?.[1] !== 'DR007' || funding[1]?.[10] !== '中债企业债到期收益率(AAA):3年') throw new Error('Funding workbook columns changed');
  for (const row of funding.slice(6)) {
    const date = excelDate(row[0]); if (!date || date > endDate) continue;
    FUNDING_FIELDS.forEach((field,i) => {
      const value = row[i+1];
      // This workbook has zero-filled unavailable observations.
      if (typeof value !== 'number' || value === 0 || !Number.isFinite(value)) return;
      const code = FUNDING_EDB[field];
      if (code) edb.push({code,observationDate:date,date,value});
    });
  }
  const equity = market.sheet('权益数据');
  for (const row of equity.slice(4)) {
    const date = excelDate(row[0]);
    if (date) EQUITY_FIELDS.forEach((field,i)=>add('equity',field,date,row[i+1],'data.xlsx#权益数据',market.hash));
    const valuationDate = excelDate(row[9]);
    if (valuationDate) Object.values(VALUATION_FIELDS).forEach((field,i)=>add('equity',field,valuationDate,row[i+10],'data.xlsx#权益数据',market.hash));
  }
  for (const row of market.sheet('二级成交量').slice(3)) {
    const date=excelDate(row[0]);
    if (!date || date !== excelDate(row[1])) continue; // Exclude whole-period total.
    SECONDARY_FIELDS.forEach((field,i)=>add('secondary',field,date,row[i+2],'data.xlsx#二级成交量',market.hash));
  }
  manifest.push({sourceKey:'data.xlsx',sourceHash:market.hash,rows:inputs.length+edb.length});

  const statMap: Record<string,string> = {'发行总额(亿)':'ISSUE_AMT','发行只数(只)':'ISSUE_NUM','偿还总额(亿)':'TOTAL_REPAY_AMT',
    '偿还只数(只)':'TOTAL_REPAY_NUM','净融资额(亿)':'NET_FINANCE_AMT','加权融资成本(%)':'WEIGHTED_COST','到期偿还额(亿)':'END_REPAY_AMT',
    '到期只数(只)':'END_REPAY_NUM','提前兑付额(亿)':'ADVANCED_REPAY_AMT','提前兑付只数(只)':'ADVANCED_REPAY_NUM',
    '回售额(亿)':'RESALE_AMT','回售只数(只)':'RESALE_NUM','赎回额(亿)':'REDEEM_AMT','赎回只数(只)':'REDEEM_NUM',
    '违约偿付额(亿)':'VIOLATE_AMT','违约偿付只数(只)':'VIOLATE_NUM','融资增长率(%)':'FINANCE_GROWTH'};
  const issueMap: Record<string,string> = {'代码':'SECUCODE','简称':'BOND_NAME_ABBR','债券全称':'BOND_NAME','发行人名称':'ISSUER_NAME',
    '企业性质':'ORGFORM','债券类型':'BOND_TYPE','发行总额(亿)':'ACTUAL_ISSUE_SCALE','发行期限':'BOND_EXPIRE_YEAR',
    '发行期限(年)':'TENOR_YEAR','票面利率(发行参考)(%)':'ISSUERATE_REFERENCE','发行利差':'ISSUECREDITSPREAD',
    '年付息次数(次)':'PAYPERYEAR','特殊剩余期限':'DEC_TOMRTYYEAR1','剩余期限(年)':'TOMRTY_YEAR','主体评级':'ISSUER_RATING',
    '债项评级':'BOND_RATING','是否含权':'IS_OEB','是否担保':'IS_GUARANTEE','利率类型':'PI_RATE_TYPE','跨市场代码':'CROSS_MARKET_CODE'};
  const sources: Array<[string,string,Record<string,string>,number]> = [
    ['发行与到期统计表(债券口径).xlsx','primary',statMap,0],['债券发行明细.xlsx','issue',issueMap,6],
    ['业务数据.xlsx','company',{'流动性覆盖率':'lcr','净稳定资金率':'nsfr','资金缺口(1M)':'funding_gap_1m','两融规模':'margin_scale'},0],
    ['主体利差.xlsx','company',{'主体利差(BP)':'subject_spread_bp','债券利差(BP)':'bond_spread_bp'},0],
  ];
  for (const [file,dataset,map,dateColumn] of sources) {
    const b=await workbook(file), matrix=b.sheet(), before=inputs.length;
    for (const row of matrix.slice(1)) {
      const date=excelDate(row[dateColumn]);if(!date)continue;
      if(dataset==='primary' && date!==excelDate(row[1]))continue;
      const entity=dataset==='issue'?String(row[1]??''):'';
      if(dataset==='issue'&&!entity)continue;
      matrix[0]!.forEach((header,i)=>{const field=map[String(header)];if(field)add(dataset,field,date,row[i],file,b.hash,entity);});
    }
    manifest.push({sourceKey:file,sourceHash:b.hash,rows:inputs.length-before});
  }
  return {inputs,edb,manifest};
}
