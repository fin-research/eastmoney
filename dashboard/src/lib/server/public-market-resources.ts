// Public report reads expose only the resources and fields used by the report.
// This is deliberately not a general /data proxy or a GraphQL endpoint.
const resources: Record<string, { fields: string; parameters: string[] }> = {
  industry: { fields: 'dataDate,equities,industries,turnoverYi,turnoverChangeYi,tradingDates', parameters: ['date'] },
  'stock-summary': { fields: 'title,time,paragraphs', parameters: ['date'] },
  'primary-issues': { fields: 'bidStartDate,issueStartDate,biddingTime,comShortName,issuerShortName,issuerShortNameCn,comFullName,issuerName,publicOffering,publicOfferingText,offeringType,issueWay,raisingMode,bondTypeText,bondShortName,issueTenor,planIssueAmount,issueCouponRate', parameters: ['date', 'startDate'] },
  'today-trades': { fields: 'bondUniCode,remainingTenor,cbYte,tradeYield,tradeYieldSubCb', parameters: ['limit'] },
  'favorite-quotes': { fields: 'bondUniCode,bondShortName,remainingTenor,remainingTenorDay,cbYield,bidYield,bidEntryPrice,ofrYield,ofrEntryPrice,tradeEntryPrice,tradeYieldSubCb', parameters: ['limit'] },
  'bond-infos': { fields: 'bondUniCode,bondShortName,comShortName,bondType,bondOfferingType,sciTechInnoBondStatus', parameters: ['codes'] },
  omo: { fields: 'operationDate,operationName,duration,interestRate,operationAmount', parameters: ['startDate', 'endDate'] },
  cfets: { fields: 'bondCode,weightedYield,weightedYieldUpDownValueBp', parameters: ['date', 'source'] },
  'bond-top-case': { fields: 'ordinateName,abscissaName,bondCode,tradeNum,yield,yieldSubYtdCloseBp', parameters: ['date'] },
  'futures-latest': { fields: 'contractCode,lastPrice,upDownValuePct', parameters: [] },
  margin: { fields: 'DIM_DATE,TOTAL_RZRQYE,TOTAL_RZYE,TOTAL_RQYE', parameters: ['date'] },
};

export function publicMarketRequest(resource: string, query: URLSearchParams): Request {
  if (!Object.hasOwn(resources, resource)) throw new Error('不支持的市场资源');
  const definition = resources[resource]!;
  const target = new URL(`/data/${resource}`, 'https://eastmoney.hasbai.xyz');
  const seen = new Set<string>();
  for (const [key, value] of query) {
    if (seen.has(key)) throw new Error('参数不得重复');
    seen.add(key);
    if (key === 'fields') {
      if (value.split(',').some((field) => !definition.fields.split(',').includes(field))) throw new Error('字段超出公开报告范围');
      continue;
    }
    if (!definition.parameters.includes(key)) throw new Error('不支持的市场参数');
    if (key === 'date' || key.endsWith('Date')) {
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || !date.toISOString().startsWith(value)) throw new Error('日期无效');
    } else if (key === 'limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > (resource === 'favorite-quotes' ? 100 : 300)) throw new Error('数量超出范围');
    } else if (key === 'source') {
      if (value !== 'DR' && value !== 'DIBO') throw new Error('资金来源无效');
    } else if (key === 'codes') {
      if (value.length > 6000 || value.split(',').length > 400 || !/^[A-Za-z0-9.,_-]+$/.test(value)) throw new Error('债券代码无效');
    }
    target.searchParams.set(key, value);
  }
  if (resource === 'bond-infos' && !target.searchParams.get('codes')) throw new Error('缺少债券代码');
  const start = target.searchParams.get('startDate');
  const end = target.searchParams.get('endDate') ?? target.searchParams.get('date');
  if ((resource === 'omo' || resource === 'primary-issues') && (!start || !end)) throw new Error('必须指定完整日期范围');
  if (start && end && (start > end || Date.parse(end) - Date.parse(start) > 40 * 86400000)) throw new Error('日期范围超出公开报告范围');
  target.searchParams.set('fields', definition.fields);
  if (resource === 'today-trades' && !seen.has('limit')) target.searchParams.set('limit', '300');
  if (resource === 'favorite-quotes' && !seen.has('limit')) target.searchParams.set('limit', '100');
  return new Request(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
}
