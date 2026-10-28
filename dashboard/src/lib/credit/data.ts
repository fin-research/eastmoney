import type {CreditItemType} from './types.ts';

export type CreditFactRow=Record<string,unknown>&{institution_name:string;effective_on:string;type:string;expiry_date?:string|null;updated_at?:string;created_at?:string};
export type CreditClientLink={institution_name:string;id:string;name:string};
export type CreditUsageRow={date:string;institution_name:string;item_type:CreditItemType;amount:number};
export type CreditDataState={date:string;position?:number;data:Record<string,unknown>&{institution_name:string;created_at?:string;updated_at?:string}};
/** Canonical database facts; no formatted report rows or derived totals. */
export interface CreditDataset {
  availableDates:string[];reportDate:string;previousDate:string|null;calendarMonth:string;
  calendarStart:string;calendarEnd:string;sixMonthStart:string;
  rows:CreditFactRow[];links:CreditClientLink[];usageEventRows:Array<{date:string;institution_name:string}>;
  usage:CreditUsageRow[];savedStates:CreditDataState[];
}

/** A scoped empty collection removes the institution's obsolete facts. */
export function applyCreditDataUpdate(current:CreditDataset,update:import('./types.ts').CreditInstitutionUpdateResponse,calendarMonth:string):CreditDataset {
  if(current.reportDate!==update.viewDate||calendarMonth!==update.calendarMonth)return current;
  const next=update.data;
  const replace=<T>(old:T[],fresh:T[],name:(row:T)=>string,key:(row:T)=>string):T[]=>{
    const replacements=new Map(fresh.map(row=>[key(row),row]));
    const result=old.flatMap(row=>{
      if(name(row)!==update.institutionName)return [row];
      const updated=replacements.get(key(row));replacements.delete(key(row));return updated?[updated]:[];
    });
    return [...result,...replacements.values()];
  };
  const states=(old:CreditDataState[],fresh:CreditDataState[])=>replace(old,fresh,r=>r.data.institution_name,r=>`${r.date}:${r.data.institution_name}`);
  const balances=(old:CreditUsageRow[],fresh:CreditUsageRow[])=>replace(old,fresh,r=>r.institution_name,r=>`${r.date}:${r.institution_name}:${r.item_type}`);
  if(update.scope==='context')return {...next,
    savedStates:[...states(current.savedStates.filter(r=>r.date===current.reportDate),next.savedStates.filter(r=>r.date===current.reportDate)),...next.savedStates.filter(r=>r.date!==current.reportDate)],
    usage:[...balances(current.usage.filter(r=>r.date===current.reportDate),next.usage.filter(r=>r.date===current.reportDate)),...next.usage.filter(r=>r.date!==current.reportDate)]};
  return {...next,rows:replace(current.rows,next.rows,r=>r.institution_name,r=>`${r.effective_on}:${r.institution_name}`),
    links:replace(current.links,next.links,r=>r.institution_name,r=>`${r.id}:${r.institution_name}`),
    usageEventRows:replace(current.usageEventRows,next.usageEventRows,r=>r.institution_name,r=>`${r.date}:${r.institution_name}`),
    usage:balances(current.usage,next.usage),savedStates:states(current.savedStates,next.savedStates)};
}
