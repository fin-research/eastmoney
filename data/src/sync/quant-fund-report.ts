import { createHash } from 'node:crypto';
import { inputValue, type QuantInput } from './quant-input-contract.ts';
import { MAX_FUND_REPORT_BYTES } from './fund-report-contract.ts';

// Parse a finite allowlist of scalar literals. Never execute uploaded scripts.
export function parseQuantFundReport(html:string,reportDate:string):QuantInput[] {
  if(Buffer.byteLength(html)>MAX_FUND_REPORT_BYTES)throw new Error('Fund report exceeds size limit');
  if(!html.includes(`证券公司资金日报 ${reportDate.replaceAll('-','')}`))throw new Error('Fund report source date mismatch');
  const hash=createHash('sha256').update(html).digest('hex');
  const key=`fund-reports/${reportDate}.html`;
  const fields:Record<string,number>={};
  for(const [id,field] of [['gLcr','lcr'],['gNsfr','nsfr']] as const) {
    const matches=[...html.matchAll(new RegExp(`mk\\(['"]${id}['"]\\)\\.setOption\\(gaugeOpt\\(['"][^'"]+['"],\\s*([\\d.]+)\\s*,`,'g'))];
    if(matches.length!==1)throw new Error(`Missing or ambiguous ${field}`);
    fields[field]=Number(matches[0]![1])/100; // Store ratios, matching quant's business workbook.
  }
  const terms=html.match(/var terms=\[([^\]]+)\];/),gaps=html.match(/var gaps=\[([^\]]+)\];/);
  if(!terms||!gaps)throw new Error('Missing static gap literals');
  const labels=JSON.parse(`[${terms[1]!.replaceAll("'",'"')}]`) as unknown;
  const amounts=JSON.parse(`[${gaps[1]}]`) as unknown;
  if(!Array.isArray(labels)||!Array.isArray(amounts)||labels.length!==amounts.length||labels.filter(x=>x==='1M').length!==1)throw new Error('Invalid gap term mapping');
  fields.static_gap_1m=Number(amounts[labels.indexOf('1M')]);
  const text=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,'');
  const margin=[...text.matchAll(/截至上一交易日我司两融规模\s*([\d,.]+)\s*亿/g)];
  if(margin.length!==1)throw new Error('Missing or ambiguous company margin balance');
  // Explicit previous-trading-day label; do not fabricate a calendar date.
  fields.margin_scale_previous_trade=Number(margin[0]![1]!.replaceAll(',',''));
  if(Object.values(fields).some(x=>!Number.isFinite(x)))throw new Error('Non-numeric fund report scalar');
  return Object.entries(fields).map(([field,value])=>inputValue('company_report',field,reportDate,value,'r2-fund-report',key,hash)!).filter(Boolean);
}
