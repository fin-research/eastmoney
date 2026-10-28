/** Workbook section headings and procedural notes are not instruments. */
/** @param {unknown} value */
export function isDebtNarrativeName(value) {
 return /^(?:发行阶段\s*[：:]|兑付阶段\s*[：:]|(?:注|说明|备注)\s*[：:]|截至目前集团共发行|\d+\s*[、．.]\s*(?:发行|簿记|投资人资金|兑付|办理|东财转))/u.test(String(value ?? '').trim());
}

/** @param {{debtType:string,name:string,amount:number|string,interestPayable:number|string,annualRate?:number|null,counterparty?:string|null,issueDate?:string|null,maturityDate?:string|null,activatedAt?:string|null,settledAt?:string|null,closedAt?:string|null,extension?:Record<string,unknown>}} debt */
export function isNarrativeOnlyDebt(debt) {
 return ['债券', '集团借款'].includes(debt.debtType)
  && isDebtNarrativeName(debt.name)
  && Number(debt.amount) === 0 && Number(debt.interestPayable) === 0
  && !debt.annualRate && !debt.counterparty
  && !Object.values(debt.extension ?? {}).some(value => value !== null && value !== undefined && value !== '' && value !== false)
  && ![debt.issueDate, debt.maturityDate, debt.activatedAt, debt.settledAt, debt.closedAt].some(Boolean);
}
