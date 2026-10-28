// @ts-nocheck
import { sha256Hex } from './hash.mjs';

export function stableDebtKey(debt, occurrence = 0) {
	return sha256Hex([
		debt.debtType,
		debt.instrumentCode,
		debt.instrumentName,
		debt.borrower,
		debt.counterparty,
		debt.principalAmount,
		debt.issueDate,
		debt.maturityDate,
		debt.annualRate,
		occurrence
	].map((value) => String(value ?? '').trim()).join('|'));
}
