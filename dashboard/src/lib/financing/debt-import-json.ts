import { z } from 'zod';
import { isNarrativeOnlyDebt } from './debt-import-rules.js';
import { DebtImportError } from './debt-import-error.ts';

const text = z.string().trim().min(1).max(2000);
const nullableText = text.nullish();
const date = z.iso.date();
const nullableDate = date.nullish();
const money = z.number().finite().nonnegative();
export const debtIdentitySchema = z.object({
  sourceKey: text, table: z.enum(['debt','bond','income_certificate','income_right','refinancing','swap_facility']),
  debtType: z.enum(['债券','收益凭证','收益权转让','同业拆借','集团借款','转融资','互换便利']),
  subtype: nullableText, name: text, legacyName: nullableText, counterparty: nullableText,
  issueDate: nullableDate, maturityDate: nullableDate
});
const extension = z.object({
  issuanceMethod: nullableText, bookbuildingDate: nullableDate, interestBasis: nullableText,
  issuanceTarget: nullableText, market: nullableText, receivingAccount: nullableText,
  trustee: nullableText, bookrunner: nullableText, liquidationSubmissionStatus: nullableText,
  liquidationRegistrationStatus: nullableText, returnType: nullableText, subscriptionDate: nullableDate,
  redemptionDate: nullableDate, earlyMaturity: z.boolean().nullish(), interestBasisDays: z.number().int().nonnegative().nullish(),
  isExtended: z.boolean().nullish(), repaymentAccount: nullableText, averageRepoBalanceDescription: nullableText,
  repoWeightedAverageRate: z.number().finite().nullish()
}).strict();
export const debtSchema = debtIdentitySchema.extend({
  amount: money, interestPayable: money, annualRate: z.number().finite().nullish(),
  activatedAt: nullableDate, settledAt: nullableDate, closedAt: nullableDate, extension
});
const cashflow = z.object({
  sourceKey: text, cashflowType: z.enum(['principal','interest','fee','supplemental']), dueDate: date,
  amount: money.nullable(), paidAmount: money.nullish(), paidAt: nullableDate,
  accrualStartDate: nullableDate, accrualEndDate: nullableDate, note: nullableText,
  sourceSequence: z.number().int().nonnegative().optional(), sequence: z.number().int().nonnegative().optional()
});
const balance = z.object({asOfDate: date, debtType: z.enum(['债券','收益凭证','收益权转让','同业拆借','集团借款','转融资','互换便利']), subtype: z.string().max(200).nullish(), amount: money}).refine(b => b.debtType === '债券' ? ['小公募','次级债','私募债','科创债','短期融资券','公司债'].includes(b.subtype ?? '') : !b.subtype, '余额品种与子类不匹配');
const snapshot = z.object({asOfDate: date, totalYi: money});
const workbookSchema = z.object({
  snapshot,
  debts: z.array(debtSchema).max(100000), cashflows: z.array(cashflow).max(200000),
  balances: z.array(balance).max(100000), snapshotBalances: z.array(balance).min(1).max(1000)
});
export const importIndexRequestSchema = z.object({action:z.literal('index')}).strict();
export const importIndexSchema = z.object({
  version:z.string().min(1).max(200),
  debts:z.array(debtIdentitySchema.pick({table:true,debtType:true,subtype:true,name:true,counterparty:true,issueDate:true,maturityDate:true})).max(100000),
  balanceKeys:z.array(z.string()).max(100000)
});
export const importCommitSchema = workbookSchema.extend({action:z.literal('commit'),version:z.string().min(1).max(200)});
export type ImportWorkbook = z.infer<typeof workbookSchema>;
export type ImportCommit = z.infer<typeof importCommitSchema>;
export function validateWorkbook(input: { debts: unknown[]; cashflows: unknown[]; balances: unknown[]; snapshot: unknown }) {
  const parsed = workbookSchema.parse({...input, snapshotBalances:input.balances.filter((b: any)=>b.asOfDate === (input.snapshot as any).asOfDate)});
  validateIncrement(parsed);
  return parsed;
}
export function validateIncrement(input: ImportWorkbook) {
  const keys = new Set<string>();
  for (const debt of input.debts) {
    if (isNarrativeOnlyDebt(debt)) throw new DebtImportError('说明文字不能作为负债导入');
    if (keys.has(debt.sourceKey)) throw new DebtImportError('新增负债来源键重复');
    keys.add(debt.sourceKey);
    const table = {债券:'bond',收益凭证:'income_certificate',收益权转让:'income_right',转融资:'refinancing',互换便利:'swap_facility',同业拆借:'debt',集团借款:'debt'}[debt.debtType];
    if (debt.table !== table) throw new DebtImportError('负债品种与继承表不一致');
  }
  for (const flow of input.cashflows) if (!keys.has(flow.sourceKey)) throw new DebtImportError('现金流没有对应新增负债');
  for (const balances of [input.balances,input.snapshotBalances]) {
    const seen = new Set<string>();
    for (const b of balances) {const key=balanceKey(b);if(seen.has(key)) throw new DebtImportError('余额日期与品种重复');seen.add(key);}
  }
  if(input.snapshotBalances.some(b=>b.asOfDate!==input.snapshot.asOfDate)) throw new DebtImportError('余额基准日不一致');
  for(const b of input.balances.filter(b=>b.asOfDate===input.snapshot.asOfDate)){const expected=input.snapshotBalances.find(s=>balanceKey(s)===balanceKey(b));if(!expected||expected.amount!==b.amount)throw new DebtImportError('新增余额与基准日分项不一致');}
  const total=input.snapshotBalances.reduce((sum,b)=>sum+b.amount,0)/100000000;
  if(Math.abs(total-input.snapshot.totalYi)>0.0001) throw new DebtImportError('余额分项与汇总不一致');
}
export function balanceKey(b: {asOfDate:string;debtType:string;subtype?:string|null}) {return JSON.stringify([b.asOfDate,b.debtType,b.subtype??'']);}


/** Upload whole potentially competing identity groups; all other historical rows stay local. */
export function incrementForIndex(workbook: ImportWorkbook, rawIndex: unknown): ImportCommit {
  const index=importIndexSchema.parse(rawIndex);
  const identityKey=(debt: {debtType:string;subtype?:string|null;name:string;counterparty?:string|null;issueDate?:string|null;maturityDate?:string|null}, name=debt.name) =>
    JSON.stringify([debt.debtType,debt.subtype??null,name,debt.counterparty??null,debt.issueDate??null,debt.maturityDate??null]);
  const exactKey=(debt: ImportWorkbook['debts'][number], name=debt.name) => JSON.stringify([identityKey(debt,name),debt.table]);
  const counts=new Map<string,number>();
  const swapKey=(debt: {debtType:string;subtype?:string|null;name:string;counterparty?:string|null;maturityDate?:string|null}) =>
    JSON.stringify([debt.debtType,debt.subtype??null,debt.name,debt.counterparty??null,debt.maturityDate??null]);
  const swapCounts=new Map<string,number>();
  for(const debt of index.debts){
    const key=JSON.stringify([identityKey(debt),debt.table]);counts.set(key,(counts.get(key)??0)+1);
    if(debt.debtType==='互换便利'){const swap=swapKey(debt);swapCounts.set(swap,(swapCounts.get(swap)??0)+1);}
  }
  const parent=workbook.debts.map((_,i)=>i);
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]!]!;i=parent[i]!;}return i;};
  const owners=new Map<string,number>();
  workbook.debts.forEach((debt,i)=>{
    const common=[debt.debtType,debt.subtype??null,debt.counterparty??null];
    const links=new Set([
      `exact:${identityKey(debt)}`,
      `broad:${JSON.stringify([...common,debt.name,debt.issueDate??null])}`,
      ...(debt.debtType==='收益凭证'&&debt.legacyName?[`exact:${identityKey(debt,debt.legacyName)}`]:[]),
      ...(debt.debtType==='互换便利'?[`swap:${JSON.stringify([...common,debt.name,debt.maturityDate??null])}`]:[])
    ]);
    for(const link of links){const owner=owners.get(link);if(owner===undefined)owners.set(link,i);else parent[root(i)]=root(owner);}
  });
  const groups=new Map<number,number[]>();
  workbook.debts.forEach((_,i)=>{const id=root(i);const group=groups.get(id)??[];group.push(i);groups.set(id,group);});
  const selected=new Set<string>();
  for(const group of groups.values()){
    const sourceCounts=new Map<string,number>();
    for(const i of group){const key=exactKey(workbook.debts[i]!);sourceCounts.set(key,(sourceCounts.get(key)??0)+1);}
    const covered=[...sourceCounts].every(([key,count])=>count<=(counts.get(key)??0))
      && group.every(i=>{
        const debt=workbook.debts[i]!;
        return debt.debtType!=='互换便利' || swapCounts.get(swapKey(debt))===counts.get(exactKey(debt));
      });
    if(!covered)for(const i of group)selected.add(workbook.debts[i]!.sourceKey);
  }
  const balances=new Set(index.balanceKeys);
  const increment:ImportCommit={...workbook,action:'commit',version:index.version,
    debts:workbook.debts.filter(d=>selected.has(d.sourceKey)),cashflows:workbook.cashflows.filter(c=>selected.has(c.sourceKey)),
    balances:workbook.balances.filter(b=>!balances.has(balanceKey(b)))};
  validateIncrement(increment);
  return increment;
}
