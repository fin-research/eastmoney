import { amountNumber, amountsDiffer, amountsEqual, secondaryUsageFromYuan, subtractAmounts } from '../credit/amounts.ts';
import { creditItemLabels, creditItemTypes, type CreditAmountChange, type CreditCalendarEvent,
  type CreditEventType, type CreditInstitutionUpdateResponse, type CreditInstitutionView,
  type CreditUsageType, type CreditUsageDetail, type CreditItemType, type CreditReportResponse, type CreditSummaryView,
  type CreditWeeklyNewsItem, type ParsedCreditWorkbook } from '../credit/types.ts';
import { toCreditEntryPatch, toCreditImportPatch } from '../credit/entry.ts';
import type { CreditInstitutionUpdateInput } from '../credit/update.ts';
import {buildCreditReport} from '../credit/build-report.ts';
export {compareCreditSnapshots,buildWeeklyCreditNews} from '../credit/build-report.ts';
import type {CreditDataset,CreditFactRow as DiffRow,CreditClientLink as ClientLink,CreditUsageRow as UsageRow} from '../credit/data.ts';
import { creditEffectiveStatus, isCreditEffective } from '../credit/validity.ts';
import type { DatabaseClient } from './postgres.ts';
import { loadCreditStates } from './credit-snapshots.ts';

const creditDateFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export class CreditDatabaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'CreditDatabaseError'; }
}

export interface PersistCreditImportInput { parsed: ParsedCreditWorkbook; createdBy?: string | null }
export interface PersistCreditImportResult {
  reportDate: string; institutionCount: number; approvedCount: number; totalLimit: number; totalUsed: number;
  totalAvailable: number; weeklyApprovedCount: number; weeklyTotalLimit: number; weeklyTotalUsed: number;
  weeklyTotalAvailable: number; addedDiffCount: number; replaced: boolean; warnings: string[];
}

export async function persistCreditWorkbook(client: DatabaseClient, input: PersistCreditImportInput): Promise<PersistCreditImportResult> {
  const { parsed } = input;
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0))");
    // Imports are observations: identical fields produce no row, including a same-day reimport.
    const inserted = await client.query(`SELECT credit.append_entry($1::date,row.name,row.patch,$3) AS id
      FROM jsonb_to_recordset($2::jsonb) AS row(name text,patch jsonb)`,
      [parsed.reportDate,JSON.stringify(parsed.institutions.map(institution => ({name:institution.institutionName,patch:toCreditImportPatch(institution)}))),input.createdBy ?? null]);
    // Linking runs on INSERT, so calculate residuals after new institutions have their clients.
    const primary = (await client.query<{institution_name:string; amount:string}>(
      'SELECT * FROM credit.bond_primary_usage_as_of($1::date)', [parsed.reportDate])).rows;
    const linked = new Set((await client.query<{institution_name:string}>(
      'SELECT DISTINCT institution_name FROM credit.institution_client')).rows.map(row => row.institution_name));
    const residuals = parsed.institutions.filter(row => linked.has(row.institutionName)).map(row => ({
      name: row.institutionName, patch: { bond_investment_secondary_used: secondaryUsageFromYuan(
        row.items.find(item => item.type === 'bond_investment')?.usedAmount ?? 0,
        primary.find(item => item.institution_name === row.institutionName)?.amount ?? '0',
      ) },
    }));
    if (parsed.institutions.some(row => !linked.has(row.institutionName) && (row.items.find(item => item.type === 'bond_investment')?.usedAmount ?? 0) !== 0)) {
      throw new CreditDatabaseError(400,'债券投资非零的机构缺少客户关联，无法登记二级买卖差额');
    }
    const reconciled = await client.query(`SELECT credit.append_entry($1::date,row.name,row.patch,$3) AS id
      FROM jsonb_to_recordset($2::jsonb) AS row(name text,patch jsonb)`,
      [parsed.reportDate,JSON.stringify(residuals),input.createdBy ?? null]);
    const addedDiffCount = [...inserted.rows,...reconciled.rows].filter(row => row.id != null).length;
    const report = await loadCreditReport(client, parsed.reportDate);
    const warnings = [...(parsed.warnings ?? [])];
    for (const institution of report.institutions) {
      const source = parsed.institutions.find(row => row.institutionName === institution.institutionName);
      if (!source) continue;
      for (const item of institution.items) {
        if (item.type === 'other') continue;
        if (source.items.find(value => value.type === item.type)?.limitAmount == null && item.limitAmount != null && item.limitAmount !== 0) {
          warnings.push(`${institution.institutionName}：${creditItemLabels[item.type]}额度原表空白，保留线上${item.limitAmount}亿元；取消额度请明确填0`);
        }
      }
      for (const type of ['yield_certificate','interbank_lending'] as const) {
        const actual = institution.items.find(item => item.type === type)?.usedAmount;
        const imported = source.items.find(item => item.type === type)?.usedAmount;
        if (actual == null) warnings.push(`${institution.institutionName}：客户关联缺失，${creditItemLabels[type]}已用无法计算，请维护客户关联`);
        else if (different(actual,imported ?? 0)) warnings.push(`${institution.institutionName}：${creditItemLabels[type]}原表${imported ?? 0}亿元，融资台账${actual}亿元，差额${subtractAmounts(actual,imported ?? 0)}亿元；使用融资台账金额`);
      }
    }
    await client.query('COMMIT');
    const s = report.summary;
    return { reportDate: parsed.reportDate,institutionCount:parsed.institutions.length,approvedCount:s.approvedCount,
      totalLimit:s.totalLimit,totalUsed:s.totalUsed,totalAvailable:s.totalAvailable,weeklyApprovedCount:s.approvedCount,
      weeklyTotalLimit:s.totalLimit,weeklyTotalUsed:s.totalUsed,weeklyTotalAvailable:s.totalAvailable,
      addedDiffCount,replaced:false,warnings };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}


export async function loadCreditReport(client: DatabaseClient, requestedDate: string | null = null, calendarMonth?: string): Promise<CreditReportResponse> {
  return buildCreditReport(await loadCreditData(client,requestedDate,calendarMonth));
}

export async function loadCreditData(client: DatabaseClient, requestedDate: string | null = null, calendarMonth?: string, selectedName?: string, currentName?: string): Promise<CreditDataset> {
  const availableDates = (await client.query<{date:string}>("SELECT DISTINCT to_char(report_date,'YYYY-MM-DD') AS date FROM credit.entry ORDER BY date")).rows.map(row => row.date);
  const reportDate = requestedDate ?? creditDateFormatter.format(new Date());
  const firstDate = availableDates[0];
  if (!firstDate || reportDate < firstDate) throw new CreditDatabaseError(404,requestedDate ? `${requestedDate} 授信记录不存在` : '暂无授信记录');
  const previousDate = addDays(reportDate,-7) >= firstDate ? addDays(reportDate,-7) : availableDates.filter(date => date < reportDate).at(-1) ?? null;
  const monthStart = `${calendarMonth ?? reportDate.slice(0,7)}-01`;
  const calendarStart = addDays(monthStart,-6);
  const calendarEnd = addDays(monthStart,41);
  const sixMonths = new Date(`${reportDate}T00:00:00Z`);
  sixMonths.setUTCMonth(sixMonths.getUTCMonth()-6);
  const newsStart = [sixMonths.toISOString().slice(0,10),previousDate ? addDays(previousDate,-7) : firstDate].sort()[0];
  const rows = (await client.query<DiffRow>(`SELECT i.name AS institution_name,to_char(e.report_date,'YYYY-MM-DD') AS effective_on,e.event::text AS type,
      (max(e.v_date) FILTER(WHERE e.field_id='expiry_date' AND e.v_date<>DATE '1970-01-01'))::text AS expiry_date
    FROM credit.entry e JOIN credit.institution i ON i.id=e.institution_id
    WHERE ($1::text IS NULL OR i.name=$1)
      AND (e.report_date BETWEEN $2::date AND $3::date OR e.report_date BETWEEN $4::date AND $5::date
        OR e.field_id='expiry_date' AND (e.v_date BETWEEN $2::date AND $3::date OR e.v_date BETWEEN $4::date AND $5::date))
    GROUP BY i.id,i.name,e.report_date,e.event ORDER BY e.report_date,i.id`,[selectedName ?? null,newsStart,reportDate,calendarStart,calendarEnd])).rows;
  const links = (await client.query<ClientLink>(`SELECT m.institution_name,c.id::text AS id,c.name
    FROM credit.institution_client m JOIN public.client c ON c.id=m.client_id WHERE ($1::text IS NULL OR m.institution_name=$1) ORDER BY m.institution_name,c.name`,[selectedName ?? null])).rows;
  const usageEventRows = (await client.query<{date:string;institution_name:string}>(`SELECT DISTINCT to_char(v.date,'YYYY-MM-DD') AS date,m.institution_name
    FROM financing.debt d JOIN credit.institution_client m ON m.client_id=d.client_id
    CROSS JOIN LATERAL (VALUES(d.activated_at),(d.maturity_date),(d.settled_at),(d.closed_at)) v(date)
    WHERE d.debt_type IN ('收益凭证','同业拆借') AND v.date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR m.institution_name=$3)
    UNION SELECT DISTINCT to_char(v.date,'YYYY-MM-DD') AS date,m.institution_name
    FROM financing.bond b JOIN financing.bond_investors i ON i.bond_id=b.id
    JOIN credit.institution_client m ON m.client_id=i.investor_id
    CROSS JOIN LATERAL (VALUES(b.issue_date),(b.maturity_date),(b.settled_at),(b.closed_at)) v(date)
    WHERE v.date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR m.institution_name=$3) ORDER BY date`,[calendarStart,calendarEnd,selectedName ?? null])).rows;
  const usageDates = usageEventRows.map(row => row.date);
  const eventDates = new Set(rows.filter(row=>row.type !== 'maintenance').map(row=>row.effective_on));
  // Historical expiries feed news; future expiries only feed the selected calendar.
  // Do not materialize full institution/item views for unrelated future dates.
  for (const row of rows) if (row.expiry_date) {
    const date = String(row.expiry_date);
    if (date <= reportDate || date >= calendarStart && date <= calendarEnd) eventDates.add(date);
  }
  const usageEventDates = [...new Set([...usageDates,...rows.filter(row => row.effective_on>=calendarStart && row.effective_on<=calendarEnd).map(row=>row.effective_on)])].sort();
  const snapshotDates = new Set([reportDate,...eventDates,...usageEventDates,...(previousDate ? [previousDate] : [])]);
  for (const date of [...eventDates,...usageEventDates]) snapshotDates.add(addDays(date,-1));
  const calendarBeforeStart = addDays(calendarStart,-1);
  const financeDates = [...new Set([reportDate,...(previousDate ? [previousDate] : []),
    ...[...snapshotDates].filter(date => date >= calendarBeforeStart && date <= calendarEnd)])].sort();
  // Current/comparison tables are SQL snapshots. Event dates request only affected names.
  const requested = new Map<string,Set<string>|null>();
  const addRequest = (date:string,names:string[]|null) => {
    if(date===reportDate&&currentName)names=[currentName];
    if (requested.has(date) && requested.get(date) === null) return;
    if (names === null) { requested.set(date,null); return; }
    const group = requested.get(date) ?? new Set<string>();
    for (const name of names) group.add(name);
    requested.set(date,group);
  };
  addRequest(reportDate,selectedName ? [selectedName] : null);
  if (previousDate) addRequest(previousDate,selectedName ? [selectedName] : null);
  for (const date of eventDates) {
    if (date < firstDate || date > reportDate && (date < calendarStart || date > calendarEnd)) continue;
    const names = rows.filter(row => row.effective_on === date || row.expiry_date === date).map(row => row.institution_name);
    addRequest(date,names); addRequest(addDays(date,-1),names);
  }
  for (const date of usageEventDates) {
    const names = [...usageEventRows.filter(row=>row.date===date),...rows.filter(row=>row.effective_on===date)].map(row=>row.institution_name);
    addRequest(date,names); addRequest(addDays(date,-1),names);
  }
  const usage = (await client.query<Omit<UsageRow,'amount'> & {amount:string}>(`SELECT to_char(d.date,'YYYY-MM-DD') AS date,m.institution_name,
    CASE u.debt_type WHEN '收益凭证' THEN 'yield_certificate' ELSE 'interbank_lending' END AS item_type,
    sum(u.amount)/100000000 AS amount
    FROM jsonb_to_recordset($1::jsonb) d(date date,names text[]) CROSS JOIN LATERAL financing.credit_usage_as_of(d.date) u
    JOIN credit.institution_client m ON m.client_id=u.client_id WHERE (d.names IS NULL OR m.institution_name=ANY(d.names)) AND ($2::text IS NULL OR m.institution_name=$2) GROUP BY d.date,m.institution_name,u.debt_type
    UNION ALL SELECT to_char(d.date,'YYYY-MM-DD'),u.institution_name,'bond_investment',u.amount/100000000
    FROM jsonb_to_recordset($1::jsonb) d(date date,names text[]) CROSS JOIN LATERAL credit.bond_primary_usage_as_of(d.date) u WHERE (d.names IS NULL OR u.institution_name=ANY(d.names)) AND ($2::text IS NULL OR u.institution_name=$2)`,[JSON.stringify(financeDates.map(date => ({date,names:requested.get(date) === null ? null : [...(requested.get(date) ?? [])]}))),selectedName ?? null])).rows.map(row => ({...row,amount:amountNumber(row.amount)}));
  const savedStates = await loadCreditStates(client,[...requested].map(([date,names])=>({date,names:names === null ? null : [...names],include_details:date===reportDate})));
  return {availableDates,reportDate,previousDate,calendarMonth:calendarMonth??reportDate.slice(0,7),calendarStart,calendarEnd,
    sixMonthStart:sixMonths.toISOString().slice(0,10),rows,links,usageEventRows,usage,savedStates};
}

export async function saveCreditInstitution(client: DatabaseClient,input: CreditInstitutionUpdateInput,createdBy: string | null = null,create = false): Promise<CreditInstitutionUpdateResponse> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0))");
    const beforeDates=(await client.query<{date:string}>("SELECT DISTINCT to_char(report_date,'YYYY-MM-DD') AS date FROM credit.entry ORDER BY date")).rows.map(row=>row.date);
    const existing = await client.query('SELECT * FROM credit.entry_as_of($1::date,ARRAY[$2::text])',[input.reportDate,input.institutionName]);
    const registered=(await client.query('SELECT id FROM credit.institution WHERE name=$1',[input.institutionName])).rows.length>0;
    if (!create && !existing.rows.length) throw new CreditDatabaseError(404,'该授信记录不存在');
    if (create && registered) throw new CreditDatabaseError(409,'该授信机构已存在，请选择对应授信申请操作');
    const operation = input.operation ?? (create ? 'new' : 'maintenance');
    if (create !== (operation === 'new')) throw new CreditDatabaseError(400,'授信申请操作与机构状态不匹配');
    const before = existing.rows[0];
    const fields = input.changes.institution ?? {};
    if (operation === 'maintenance' && fields.totalLimit != null &&
      (before?.total == null || !amountsEqual(fields.totalLimit, before.total))) {
      throw new CreditDatabaseError(400,'维护不能变更授信总额，请使用授信申请');
    }
    const allowedFields = operation === 'renewal' ? ['effectiveDate','expiryDate','totalLimit','notes']
      : operation === 'increase' ? ['totalLimit','notes']
        : operation === 'revocation' ? ['expiryDate','status','notes'] : null;
    if (allowedFields && Object.keys(fields).some(field => !allowedFields.includes(field))) {
      throw new CreditDatabaseError(400,'该授信申请包含不属于本操作的字段');
    }
    if ((operation === 'renewal' || operation === 'revocation') && input.changes.items?.length ||
      operation === 'increase' && input.changes.items?.some(item => Object.keys(item).some(field => field !== 'type' && field !== 'limitAmount'))) {
      throw new CreditDatabaseError(400,'该授信申请包含不属于本操作的分项字段');
    }
    if (operation === 'new' && (fields.status === 'revoked' || fields.expiryDate === '1970-01-01') ||
      operation === 'maintenance' && (fields.status === 'revoked' || fields.expiryDate === '1970-01-01')) {
      throw new CreditDatabaseError(400,'撤销须使用对应授信申请操作');
    }
    if (operation === 'renewal' &&
      (before.status === 'revoked' || !fields.expiryDate || before.expiry_date && fields.expiryDate <= databaseDate(before.expiry_date))) {
      throw new CreditDatabaseError(400,'续期须为未撤销机构填写晚于原到期日的新到期日');
    }
    if (operation === 'increase' &&
      (before.status !== 'approved' || fields.totalLimit == null || Number(fields.totalLimit) <= Number(before.total ?? 0))) {
      throw new CreditDatabaseError(400,'扩额须为已获批机构填写高于原额度的新总额');
    }
    if (operation === 'revocation') {
      if (before.status === 'revoked') throw new CreditDatabaseError(400,'该机构已撤销');
      fields.expiryDate = '1970-01-01';
      fields.status = 'revoked';
    }
    const patch = toCreditEntryPatch(input.changes);
    for (const [field,value] of Object.entries(patch)) {
      if (value === null && (field === 'total' || field.endsWith('_limit') || field.endsWith('_used')) && existing.rows[0]?.[field] != null) {
        throw new CreditDatabaseError(400,'空白不修改已登记金额；取消额度或清零已用请填0');
      }
    }
    const afterExpiry=fields.expiryDate??(before?.expiry_date ? databaseDate(before.expiry_date) : null);
    const afterStatus=creditEffectiveStatus({reportDate:input.reportDate,expiryDate:afterExpiry,status:fields.status??before?.status??'applying'});
    const maintenanceRenewal = operation === 'maintenance' && fields.expiryDate != null &&
      before?.expiry_date != null && databaseDate(before.expiry_date) !== '1970-01-01' &&
      fields.expiryDate > databaseDate(before.expiry_date);
    const eventType = operation === 'renewal' && fields.totalLimit != null && Number(fields.totalLimit)>Number(before.total ?? 0)
      ? 'increase' : maintenanceRenewal ? 'renewal'
        : operation === 'maintenance' && before?.status === 'applying' && afterStatus === 'approved'
          ? 'new' : operation;
    if (eventType === 'maintenance') {
      await client.query('SELECT credit.append_entry($1::date,$2,$3::jsonb,$4) AS id',
        [input.reportDate,input.institutionName,JSON.stringify(patch),createdBy]);
    } else {
      await client.query('SELECT credit.append_entry($1::date,$2,$3::jsonb,$4,$5) AS id',
        [input.reportDate,input.institutionName,JSON.stringify(patch),createdBy,eventType]);
    }
    const data=await loadCreditData(client,input.viewDate??input.reportDate,input.calendarMonth,input.institutionName);
    const beforeFirstDate=input.viewFirstDate??beforeDates[0];
    const beforePreviousDate=input.viewPreviousDate!==undefined?input.viewPreviousDate:
      addDays(data.reportDate,-7)>=(beforeDates[0]??data.reportDate)?addDays(data.reportDate,-7):beforeDates.filter(date=>date<data.reportDate).at(-1)??null;
    // Date boundaries change the data required for other institutions. Supply a
    // canonical replacement dataset in this rare case; no extra browser GET.
    const reset=beforeFirstDate!==data.availableDates[0]||beforePreviousDate!==data.previousDate;
    const replacement=reset?await loadCreditData(client,data.reportDate,data.calendarMonth,undefined,input.institutionName):data;
    await client.query('COMMIT');
    return {institutionName:input.institutionName,viewDate:data.reportDate,calendarMonth:data.calendarMonth,
      scope:reset?'context':'institution',data:replacement};

  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    if (error instanceof Error && error.message === 'Credit entry writes await cutover') throw new CreditDatabaseError(503,'授信数据正在切换，请稍后保存');
    if (error instanceof Error && error.message === 'Credit expiry precedes effective date') throw new CreditDatabaseError(400,'授信到期日不能早于生效日');
    throw error;
  }
}

function addDays(date:string,days:number):string { const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10); }
function databaseDate(value: unknown): string { return value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10); }
function different(left:number,right:number):boolean {return amountsDiffer(left,right);}

/** Minimal, institution-scoped drilldown; amounts match the report's historical principal. */
export async function loadCreditUsage(client: DatabaseClient, reportDate: string, institutionName: string, type: CreditUsageType, offset = 0): Promise<CreditUsageDetail> {
  const institution = (await client.query<{linked:boolean}>(`SELECT EXISTS(SELECT 1 FROM credit.institution_client m WHERE m.institution_name=i.name) AS linked
    FROM credit.institution i WHERE i.name=$1`,[institutionName])).rows[0];
  if (!institution) throw new CreditDatabaseError(404,'该授信机构不存在');
  const source = type === 'bond_investment' ? `SELECT b.id,b.name,c.name AS client_name,sum(i.amount) AS amount,b.issue_date AS start_date,b.maturity_date
    FROM financing.bond b JOIN financing.bond_investors i ON i.bond_id=b.id
    JOIN credit.institution_client m ON m.client_id=i.investor_id JOIN public.client c ON c.id=i.investor_id
    WHERE m.institution_name=$1 AND b.issue_date<=$2::date AND b.maturity_date>$2::date
      AND (b.settled_at IS NULL OR b.settled_at>$2::date) AND (b.closed_at IS NULL OR b.closed_at>$2::date)
    GROUP BY b.id,b.name,c.name,b.issue_date,b.maturity_date` : `SELECT d.id,d.name,c.name AS client_name,d.amount,d.activated_at AS start_date,d.maturity_date
    FROM financing.debt d JOIN credit.institution_client m ON m.client_id=d.client_id JOIN public.client c ON c.id=d.client_id
    WHERE m.institution_name=$1 AND d.debt_type=$4 AND d.activated_at<=$2::date
      AND (d.maturity_date IS NULL OR d.maturity_date>$2::date)
      AND (d.settled_at IS NULL OR d.settled_at>$2::date) AND (d.closed_at IS NULL OR d.closed_at>$2::date)`;
  const result = (await client.query<{total:string;count:string;items:CreditUsageDetail['items']}>(`WITH entries AS (${source}), page AS (
    SELECT id::text,name,client_name AS "clientName",amount/100000000 AS amount,
      to_char(start_date,'YYYY-MM-DD') AS "startDate",to_char(maturity_date,'YYYY-MM-DD') AS "maturityDate"
    FROM entries ORDER BY start_date DESC,id,client_name LIMIT 100 OFFSET $3)
    SELECT coalesce(sum(amount),0)/100000000 AS total,count(*)::text AS count,
      coalesce((SELECT jsonb_agg(page) FROM page),'[]'::jsonb) AS items FROM entries`,
    type === 'bond_investment' ? [institutionName,reportDate,offset] : [institutionName,reportDate,offset,type === 'yield_certificate' ? '收益凭证' : '同业拆借'])).rows[0]!;
  return {reportDate,institutionName,type,linked:institution.linked,totalUsed:institution.linked ? amountNumber(result.total) : null,
    totalCount:Number(result.count),offset,items:result.items.map(item=>({...item,amount:amountNumber(item.amount)}))};
}
