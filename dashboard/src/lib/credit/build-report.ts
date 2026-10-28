import { amountsDiffer, subtractAmounts, sumAmounts } from './amounts.ts';
import {creditItemLabels,creditItemTypes,type CreditAmountChange,type CreditCalendarEvent,type CreditEventType,type CreditInstitutionView,type CreditItemType,type CreditReportResponse,type CreditSummaryView,type CreditWeeklyNewsItem} from './types.ts';
import type {CreditDataset,CreditFactRow} from './data.ts';
import {compareCreditInstitutionOrder} from './presentation.ts';
import {creditEffectiveStatus,isCreditEffective} from './validity.ts';
type DiffRow=import('./data.ts').CreditDataState['data'];
function itemUsage(state: DiffRow, date: string, type: CreditItemType, linked: boolean, usage: Map<string,number>) {
  const bond = type === 'bond_investment';
  const financing = bond || type === 'yield_certificate' || type === 'interbank_lending';
  const primaryUsedAmount = linked ? usage.get(`${date}:${state.institution_name}:${type}`) ?? 0 : null;
  const secondaryUsedAmount = nullableNumber(state.bond_investment_secondary_used) ?? 0;
  const usedAmount = financing ? (primaryUsedAmount == null ? null : sumAmounts([primaryUsedAmount,bond ? secondaryUsedAmount : 0]))
    : nullableNumber(state[`${type}_used`]);
  return {usedAmount,primaryUsedAmount,secondaryUsedAmount};
}

function institutionView(state: DiffRow, date: string, clients: Array<{id:string;name:string}>, usage: Map<string,number>): CreditInstitutionView {
  const items = creditItemTypes.map(type => {
    const bond = type === 'bond_investment';
    const financing = bond || type === 'yield_certificate' || type === 'interbank_lending';
    const limitAmount = type === 'other' ? null : nullableNumber(state[`${type}_limit`]);
    const {usedAmount,primaryUsedAmount,secondaryUsedAmount} = itemUsage(state,date,type,clients.length > 0,usage);
    const item: CreditInstitutionView['items'][number] = { type,limitAmount,usedAmount,remainingAmount:limitAmount == null || (financing && usedAmount == null) ? null : subtractAmounts(limitAmount,usedAmount ?? 0),
      details: (type === 'bond_investment' || type === 'other' ? state[`${type}_detail`] as string | null : null) ?? null,
      usageSource:bond ? 'bond_investors' : financing ? 'financing' : 'credit',linkedClientCount:clients.length };
    if (bond) { item.primaryUsedAmount = primaryUsedAmount; item.secondaryUsedAmount = secondaryUsedAmount; }
    return item;
  });
  const totalLimit = nullableNumber(state.total);
  const totalUsed = clients.length ? sumAmounts(items.map(item => item.usedAmount)) : null;
  const availableAmount = totalLimit == null || totalUsed == null ? null : subtractAmounts(totalLimit,totalUsed);
  const period = {reportDate:date,status:state.status as CreditInstitutionView['status'],
    effectiveDate:state.effective_date as string | null ?? null,expiryDate:state.expiry_date as string | null ?? null};
  return { reportDate:date,lastChangedOn:state.last_changed_on as string,verified:state.verified === true,effectiveStatus:creditEffectiveStatus(period),institutionName:state.institution_name,institutionType:state.institution_type as string,
    confidentialityStatus:state.confidentiality_status === true,status:creditEffectiveStatus(period),
    totalLimit,totalUsed,totalRemaining:availableAmount,availableAmount,utilization:totalLimit && totalUsed != null ? totalUsed/totalLimit*100 : null,
    effectiveDate:state.effective_date as string | null ?? null,expiryDate:state.expiry_date as string | null ?? null,
    bankOffice:state.bank_office as string | null ?? null,applyingDepartment:state.applying_department as string | null ?? null,
    handler:state.handler as string | null ?? null,detail:state.detail as string | null ?? null,notes:state.notes as string | null ?? null,
    bondPreference:state.bond_preference as string | null ?? null,updatedAt:state.updated_at ?? state.created_at ?? '',clients,items };
}

/** Browser-only report derivation; the API returns canonical data rows. */
export function buildCreditReport(data:CreditDataset):CreditReportResponse {
  const {availableDates,reportDate,previousDate,calendarStart,calendarEnd,sixMonthStart,rows,links,usageEventRows,usage,savedStates}=data;
  const firstDate=availableDates[0];
  if(!firstDate)throw new Error("授信数据缺少历史起点");
  const eventDates=new Set(rows.filter(row=>row.type!=='maintenance').map(row=>row.effective_on));
  for(const row of rows)if(row.expiry_date){const date=String(row.expiry_date);if(date<=reportDate||date>=calendarStart&&date<=calendarEnd)eventDates.add(date);}
  const usageEventDates=[...new Set([...usageEventRows.map(row=>row.date),...rows.filter(row=>row.effective_on>=calendarStart&&row.effective_on<=calendarEnd).map(row=>row.effective_on)])].sort();
  const clientsByInstitution=new Map<string,Array<{id:string;name:string}>>();
  for(const {institution_name,id,name} of links){const group=clientsByInstitution.get(institution_name)??[];group.push({id,name});clientsByInstitution.set(institution_name,group);}
  const usageByKey=new Map(usage.map(row=>[`${row.date}:${row.institution_name}:${row.item_type}`,row.amount]));
  const cache = new Map<string,{states:Map<string,DiffRow>}>();
  for (const row of [...savedStates].sort((a,b)=>a.date.localeCompare(b.date)||(a.position??0)-(b.position??0))) {
    const saved = cache.get(row.date) ?? {states:new Map<string,DiffRow>()};
    const state = row.data as DiffRow;
    saved.states.set(state.institution_name,state);
    cache.set(row.date,saved);
  }
  const views = new Map<string,Map<string,CreditInstitutionView>>();
  const institutionSnapshot = (date:string,name:string):CreditInstitutionView|undefined => {
    const saved = cache.get(date);
    const state = saved?.states.get(name);
    if (!saved || !state) return undefined;
    const dateViews = views.get(date) ?? new Map<string,CreditInstitutionView>();
    views.set(date,dateViews);
    let view = dateViews.get(name);
    if (!view) {
      view = institutionView(state,date,clientsByInstitution.get(name) ?? [],usageByKey);
      dateViews.set(name,view);
    }
    return view;
  };
  const snapshot = (date:string) => [...(cache.get(date)?.states.keys() ?? [])].map(name => institutionSnapshot(date,name)!);
  const current = snapshot(reportDate).filter(row=>row.status!=='revoked').sort(compareCreditInstitutionOrder);
  const currentByInstitution = cache.get(reportDate)?.states ?? new Map<string,DiffRow>();
  const previous = previousDate ? snapshot(previousDate).filter(row=>row.status!=='revoked') : [];
  const revokedNames=new Set(snapshot(reportDate).filter(row=>row.status==='revoked').map(row=>row.institutionName));
  const allNews: CreditWeeklyNewsItem[] = [];
  const calendarEvents: CreditCalendarEvent[] = [];
  for (const date of [...eventDates].sort()) {
    if (date < firstDate || date > reportDate && (date < calendarStart || date > calendarEnd)) continue;
    // A diff's stored type is the event fact. Amount/date differences alone are maintenance.
    const beforeDate = addDays(date,-1);
    const before = cache.get(beforeDate)?.states;
    const news = rows.filter(row => row.effective_on === date && row.type && row.type !== 'maintenance')
      .flatMap(row => {
        const current = institutionSnapshot(date,row.institution_name);
        const previous = institutionSnapshot(beforeDate,row.institution_name);
        if (!current || row.type === 'new' && current.status !== 'approved') return [];
        const eventType = row.type === 'renewal_increase' ? 'increase' : row.type as CreditEventType;
        return [creditNewsItem(eventType,current,previous,date,beforeDate)];
      });
    if (date <= reportDate) {
      for (const previous of before?.values() ?? []) {
        if (previous.status !== 'approved' || previous.expiry_date !== date) continue;
        const latest = currentByInstitution.get(previous.institution_name);
        if (latest?.expiry_date !== date) continue;
        if (news.some(event => event.institutionName === previous.institution_name && isRenewalEvent(event))) continue;
        news.push(creditNewsItem('expiry',institutionSnapshot(date,previous.institution_name),
          institutionSnapshot(beforeDate,previous.institution_name),date,beforeDate));
      }
    }
    allNews.push(...news);
    if (date >= calendarStart && date <= calendarEnd) {
      calendarEvents.push(...news.filter(event => event.eventType !== 'expiry').map(event => calendarCreditEvent(event,reportDate)));
    }
  }
  // Only the currently recorded maturity is shown: a renewed old term disappears.
  for (const institution of snapshot(reportDate)) {
    const dates: Array<[string | null,'new'|'expiry']> = [[institution.effectiveDate,'new'],[institution.expiryDate,'expiry']];
    for (const [date,kind] of dates) {
      if (!date || date < calendarStart || date > calendarEnd || institution.status === 'revoked' || kind === 'new' && institution.status !== 'approved') continue;
      if (kind === 'new' && date > firstDate) continue;
      if (calendarEvents.some(event => event.date===date && event.institutionName===institution.institutionName && event.kind===kind)) continue;
      calendarEvents.push({id:`credit:${kind}:${institution.institutionName}:${date}`,date,type:kind==='expiry'?'expiry':'added',kind,
        institutionName:institution.institutionName,label:`${kind==='expiry'?'授信到期':'授信新增'} · ${formatCalendarAmount(institution.totalLimit)}亿元`,
        ...calendarState(date,reportDate,kind)});
    }
  }
  for (const date of usageEventDates) {
    if (date <= firstDate) continue;
    const beforeDate = addDays(date,-1);
    const before = cache.get(beforeDate)?.states;
    const affectedNames = new Set([...usageEventRows.filter(row=>row.date===date),...rows.filter(row=>row.effective_on===date)].map(row=>row.institution_name));
    for (const state of cache.get(date)?.states.values() ?? []) {
      if (!affectedNames.has(state.institution_name) || state.status==='revoked') continue;
      for (const type of creditItemTypes) {
        const linked = Boolean(clientsByInstitution.get(state.institution_name)?.length);
        const item = itemUsage(state,date,type,linked,usageByKey);
        const priorState = before?.get(state.institution_name);
        const prior = priorState ? itemUsage(priorState,beforeDate,type,linked,usageByKey) : undefined;
        // Missing client associations are unknown, not a zero balance.
        if (item.usedAmount == null || prior && prior.usedAmount == null) continue;
        const components = type === 'bond_investment'
          ? [{kind:'primary' as const,label:'债券投资——一级发行',before:prior?.primaryUsedAmount ?? 0,after:item.primaryUsedAmount ?? 0},
            {kind:'secondary' as const,label:'债券投资——二级买卖',before:prior?.secondaryUsedAmount ?? 0,after:item.secondaryUsedAmount ?? 0}]
          : [{kind:undefined,label:creditItemLabels[type],before:prior?.usedAmount ?? 0,after:item.usedAmount}];
        for (const component of components) {
          if (!amountsDiffer(component.after,component.before)) continue;
          const delta = subtractAmounts(component.after,component.before);
          calendarEvents.push({id:`usage:${state.institution_name}:${type}:${component.kind ?? 'total'}:${date}`,date,type:'usage',kind:'usage',itemType:type,
            ...(component.kind ? {usageComponent:component.kind} : {}),institutionName:state.institution_name,
            label:`${component.label} · ${delta>=0?'增加':'减少'}${formatCalendarAmount(Math.abs(delta))}亿元`,
            ...calendarState(date,reportDate,'usage')});
        }
      }
    }
  }
  const activeNews=allNews.filter(event=>!revokedNames.has(event.institutionName));
  const weeklyEvents = (start: string, end: string): CreditWeeklyNewsItem[] =>
    activeNews.filter(event => event.reportDate > start && event.reportDate <= end)
      .filter(event => event.eventType !== 'expiry' || !activeNews.some(other => other.institutionName === event.institutionName &&
        other.reportDate > start && other.reportDate <= end &&
        isRenewalEvent(other)));
  const weeklyNews = weeklyEvents(previousDate ?? addDays(firstDate,-1), reportDate);
  const previousWeeklyNews = previousDate ? weeklyEvents(addDays(previousDate,-7),previousDate) : [];
  const recentApprovals=activeNews.filter(event => event.reportDate>=sixMonthStart && event.reportDate<=reportDate && isApprovalEvent(event)).reverse();
  const summary=toSummary(reportDate,current);
  const comparison = previous;
  return {availableDates,previousDate,summary,previousSummary:previousDate?toSummary(previousDate,comparison):null,
    weeklySummary:{...summary,addedInstitutionCount:weeklyNews.filter(event=>event.eventType==='new').length,
      expiredInstitutionCount:weeklyNews.filter(event=>event.eventType==='expiry'||event.eventType==='revocation').length},
    previousWeeklySummary:previousDate?{...toSummary(previousDate,comparison),
      addedInstitutionCount:previousWeeklyNews.filter(event=>event.eventType==='new').length,
      expiredInstitutionCount:previousWeeklyNews.filter(event=>event.eventType==='expiry'||event.eventType==='revocation').length}:null,
    institutions:current,weeklyNews,previousWeeklyNews,recentApprovals,limitChanges:weeklyNews.filter(isApprovalEvent).map(toLimitChange),
    usageChanges:previousDate?compareCreditSnapshots(current,comparison,'usage').filter(row=>!revokedNames.has(row.institutionName)):[],
    calendarEvents:calendarEvents.filter(event=>!revokedNames.has(event.institutionName)).sort((a,b)=>a.date.localeCompare(b.date)||a.institutionName.localeCompare(b.institutionName,'zh-CN')||a.id.localeCompare(b.id))};
}

function formatCalendarAmount(value:number|null):string { return value == null ? '未登记' : Number(value.toFixed(6)).toString(); }
function calendarState(date:string,asOf:string,kind:string):Pick<CreditCalendarEvent,'status'|'statusLabel'> {
  return {status:date>asOf?'upcoming':date===asOf?'due':'completed',statusLabel:date>asOf?'待生效':kind==='expiry'?'已到期':'已生效'};
}
function calendarCreditEvent(event:CreditWeeklyNewsItem,asOf:string):CreditCalendarEvent {
  const labels:Record<CreditEventType,string>={new:'授信新增',renewal:'授信续作',increase:'授信扩额',decrease:'授信缩额',amendment:'授信分项额度变更',expiry:'授信到期',revocation:'授信撤销'};
  return {id:`credit:${event.eventType}:${event.institutionName}:${event.reportDate}`,date:event.reportDate,
    type:event.eventType==='expiry'||event.eventType==='revocation'?'expiry':'added',kind:event.eventType==='revocation'?'revoked':event.eventType,
    institutionName:event.institutionName,label:`${labels[event.eventType]} · ${formatCalendarAmount(event.currentAmount)}亿元`,
    ...calendarState(event.reportDate,asOf,event.eventType)};
}

function creditNewsItem(
  eventType: CreditEventType,
  current: CreditInstitutionView | undefined,
  previous: CreditInstitutionView | undefined,
  reportDate: string,
  previousReportDate: string,
): CreditWeeklyNewsItem {
  const detailSource = current ?? previous;
  const previousAmount = numberValue(previous?.totalLimit);
  const currentAmount = numberValue(current?.totalLimit);
  return {
    reportDate,previousReportDate,institutionName:detailSource?.institutionName ?? '',
    institutionType:detailSource?.institutionType ?? '未分类',eventType,
    previousStatus:previous?.status ?? null,currentStatus:current?.status ?? null,
    previousAmount,currentAmount,deltaAmount:subtractAmounts(currentAmount,previousAmount),
    previousEffectiveDate:previous?.effectiveDate ?? null,currentEffectiveDate:current?.effectiveDate ?? null,
    previousExpiryDate:previous?.expiryDate ?? null,currentExpiryDate:current?.expiryDate ?? null,
    creditDetails:(detailSource?.items ?? [])
      .filter(item => item.limitAmount != null || Boolean(item.details?.trim()))
      .map(item => ({type:item.type,limitAmount:item.limitAmount,details:item.details})),
  };
}

export function compareCreditSnapshots(
  currentInstitutions: CreditInstitutionView[],
  previousInstitutions: CreditInstitutionView[],
  mode: "limit" | "usage",
): CreditAmountChange[] {
  if (mode === "limit") {
    return buildWeeklyCreditNews(currentInstitutions, previousInstitutions)
      .filter(isApprovalEvent)
      .map(toLimitChange);
  }

  const currentByName = new Map(
    currentInstitutions.map((institution) => [institution.institutionName, institution]),
  );
  const previousByName = new Map(
    previousInstitutions.map((institution) => [institution.institutionName, institution]),
  );
  const institutionNames = new Set([...currentByName.keys(), ...previousByName.keys()]);
  const changes: CreditAmountChange[] = [];

  for (const institutionName of institutionNames) {
    const current = currentByName.get(institutionName);
    const previous = previousByName.get(institutionName);
    const previousAmount = amountForMode(previous, mode);
    const currentAmount = amountForMode(current, mode);
    const details: string[] = [];
    if (different(previousAmount, currentAmount)) {
      details.push(`总已用 ${amountTransition(previousAmount, currentAmount)}`);
    }
    for (const type of creditItemTypes) {
      const previousItem = previous?.items.find((item) => item.type === type);
      const currentItem = current?.items.find((item) => item.type === type);
      const previousValue = previous && isCreditEffective(previous)
        ? previousItem?.usedAmount ?? 0
        : 0;
      const currentValue = current && isCreditEffective(current)
        ? currentItem?.usedAmount ?? 0
        : 0;
      if (type === 'bond_investment') {
        for (const [field,label] of [['primaryUsedAmount','债券投资——一级发行'],['secondaryUsedAmount','债券投资——二级买卖']] as const) {
          const before = previous && isCreditEffective(previous) ? previousItem?.[field] ?? 0 : 0;
          const after = current && isCreditEffective(current) ? currentItem?.[field] ?? 0 : 0;
          if (different(before,after)) details.push(`${label}已用 ${amountTransition(before,after)}`);
        }
      }
      if (different(previousValue, currentValue)) {
        details.push(
          `${creditItemLabels[type]}已用 ${amountTransition(previousValue, currentValue)}`,
        );
      }
    }
    if (!previous && current && details.length > 0) {
      details.unshift("新增授信主体");
    }
    if (previous && !current && details.length > 0) {
      details.unshift("本期不再出现");
    }
    if (details.length === 0) continue;
    changes.push({
      institutionName,
      institutionType: current?.institutionType ?? previous?.institutionType ?? "未分类",
      kind: !previous ? "added" : !current ? "removed" : "changed",
      previousAmount,
      currentAmount,
      deltaAmount: subtractAmounts(currentAmount, previousAmount),
      details,
    });
  }

  return changes.sort(
    (left, right) =>
      Math.abs(right.deltaAmount) - Math.abs(left.deltaAmount) ||
      left.institutionName.localeCompare(right.institutionName, "zh-CN"),
  );
}

export function buildWeeklyCreditNews(
  currentInstitutions: CreditInstitutionView[],
  previousInstitutions: CreditInstitutionView[],
  reportDate = currentInstitutions[0]?.reportDate ?? "",
  previousReportDate = previousInstitutions[0]?.reportDate ?? "",
): CreditWeeklyNewsItem[] {
  const currentByName = new Map(
    currentInstitutions.map((institution) => [institution.institutionName, institution]),
  );
  const previousByName = new Map(
    previousInstitutions.map((institution) => [institution.institutionName, institution]),
  );
  const institutionNames = new Set([...currentByName.keys(), ...previousByName.keys()]);
  const news: CreditWeeklyNewsItem[] = [];

  for (const institutionName of institutionNames) {
    const current = currentByName.get(institutionName);
    const previous = previousByName.get(institutionName);
    const previousAmount = previous ? numberValue(previous.totalLimit) : 0;
    const currentAmount = current ? numberValue(current.totalLimit) : 0;
    const eventType = classifyInstitutionEvent(
      current,
      previous,
      currentAmount,
      previousAmount,
      reportDate,
      previousReportDate,
    );
    if (!eventType) continue;
    const detailSource = current ?? previous;

    news.push({
      reportDate,
      previousReportDate,
      institutionName,
      institutionType: current?.institutionType ?? previous?.institutionType ?? "未分类",
      eventType,
      previousStatus: previous?.status ?? null,
      currentStatus: current?.status ?? null,
      previousAmount,
      currentAmount,
      deltaAmount: subtractAmounts(currentAmount, previousAmount),
      previousEffectiveDate: previous?.effectiveDate ?? null,
      currentEffectiveDate: current?.effectiveDate ?? null,
      previousExpiryDate: previous?.expiryDate ?? null,
      currentExpiryDate: current?.expiryDate ?? null,
      creditDetails: (detailSource?.items ?? [])
        .filter((item) => item.limitAmount != null || Boolean(item.details?.trim()))
        .map((item) => ({
          type: item.type,
          limitAmount: item.limitAmount,
          details: item.details,
        })),
    });
  }

  return news;
}

function classifyInstitutionEvent(
  current: CreditInstitutionView | undefined,
  previous: CreditInstitutionView | undefined,
  currentAmount: number,
  previousAmount: number,
  reportDate: string,
  previousReportDate: string,
): CreditEventType | null {
  if (current && previous && current.status === "revoked" && previous.status !== "revoked") {
    return "revocation";
  }
  const hasApprovedPeriod = current?.status === "approved" || previous?.status === "approved";
  if (
    current &&
    previous &&
    hasApprovedPeriod &&
    currentAmount > previousAmount && amountsDiffer(currentAmount,previousAmount)
  ) {
    return "increase";
  }
  if (current && previous && hasApprovedPeriod && currentAmount < previousAmount && amountsDiffer(currentAmount,previousAmount)) return 'decrease';
  if (
    current &&
    previous &&
    hasApprovedPeriod &&
    current.expiryDate &&
    current.expiryDate !== previous.expiryDate
  ) {
    return "renewal";
  }
  if (current?.status === "approved" && previous?.status !== "approved") {
    return "new";
  }
  if (previous?.status !== "approved") return null;
  const expiryDate = current?.expiryDate ?? previous.expiryDate;
  if (!current) {
    return isDateInComparisonWindow(expiryDate, previousReportDate, reportDate)
      ? "expiry"
      : "revocation";
  }
  return isDateInComparisonWindow(expiryDate, previousReportDate, reportDate)
    ? "expiry"
    : null;
}

function toLimitChange(news: CreditWeeklyNewsItem): CreditAmountChange {
  const details: string[] = [];
  if (news.eventType === "new") {
    details.push("新增授信主体");
  }
  if (news.eventType === "increase") {
    details.push(`授信总额 ${amountTransition(news.previousAmount, news.currentAmount)}`);
  }
  if (news.eventType === "renewal") {
    details.push(
      `到期日 ${news.previousExpiryDate ?? "未登记"} → ${news.currentExpiryDate ?? "未登记"}`,
    );
  }
  return {
    institutionName: news.institutionName,
    institutionType: news.institutionType,
    kind: news.eventType === "new" ? "added" : "changed",
    previousAmount: news.previousAmount,
    currentAmount: news.currentAmount,
    deltaAmount: news.deltaAmount,
    details,
  };
}

function isApprovalEvent(news: CreditWeeklyNewsItem): boolean {
  return news.eventType === "new" || news.eventType === "renewal" || news.eventType === "increase";
}

function isRenewalEvent(news: CreditWeeklyNewsItem): boolean {
  return news.eventType === 'renewal' ||
    (news.eventType === 'increase' && news.currentExpiryDate != null &&
      news.previousExpiryDate != null && news.currentExpiryDate > news.previousExpiryDate);
}

function toSummary(
  reportDate: string,
  institutions: CreditInstitutionView[],
): CreditSummaryView {
  const approved = institutions.filter(isCreditEffective);
  const totalLimit = sumAmounts(approved.map((institution) => institution.totalLimit));
  const totalUsed = sumAmounts(approved.map((institution) => institution.totalUsed));
  const totalAvailable = sumAmounts(
    approved.map((institution) => institution.availableAmount),
  );
  return {
    reportDate,
    institutionCount: institutions.filter((institution) => institution.status !== "revoked").length,
    approvedCount: approved.length,
    totalLimit,
    totalUsed,
    totalAvailable,
    utilization: totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0,
    expiringWithin30Days: approved.filter((institution) => {
      if (!institution.expiryDate) return false;
      const days = dayDifference(reportDate, institution.expiryDate);
      return days >= 0 && days <= 30;
    }).length,
  };
}

function amountForMode(
  institution: CreditInstitutionView | undefined,
  mode: "limit" | "usage",
): number {
  if (!institution || !isCreditEffective(institution)) return 0;
  return mode === "limit"
    ? institution.totalLimit ?? 0
    : institution.totalUsed ?? 0;
}

function amountTransition(previous: number, current: number): string {
  const delta = subtractAmounts(current, previous);
  return `${previous.toFixed(2)} → ${current.toFixed(2)} 亿元（${delta >= 0 ? "+" : ""}${delta.toFixed(2)}）`;
}

function different(left: number, right: number): boolean {
  return amountsDiffer(left, right);
}

function dayDifference(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
}

function isDateInComparisonWindow(
  value: string | null | undefined,
  previousReportDate: string,
  reportDate: string,
): boolean {
  return Boolean(
    value &&
    previousReportDate &&
    reportDate &&
    value > previousReportDate &&
    value <= reportDate,
  );
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberValue(value: unknown): number {
  return nullableNumber(value) ?? 0;
}

function addDays(date:string,days:number):string {const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);}
