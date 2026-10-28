import Decimal from 'decimal.js';

// Keep decimal arithmetic local; match PostgreSQL numeric rounding at the
// six-place credit boundary, without rounding individual financing balances.
const CreditDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Amount = number | string;

export function sumAmounts(values: Array<Amount | null>): number {
  return values.reduce((sum, value) => sum.plus(value ?? 0), new CreditDecimal(0))
    .toDecimalPlaces(6).toNumber();
}

export function subtractAmounts(left: Amount, right: Amount): number {
  return new CreditDecimal(left).minus(right).toDecimalPlaces(6).toNumber();
}

/** Match equality after each value crosses PostgreSQL's numeric(20,6) boundary. */
export function amountsEqual(left: Amount, right: Amount): boolean {
  return new CreditDecimal(left).toDecimalPlaces(6).eq(new CreditDecimal(right).toDecimalPlaces(6));
}

/** Compare the unrounded delta so the existing 100-yuan threshold stays exact. */
export function amountsDiffer(left: Amount, right: Amount): boolean {
  return new CreditDecimal(left).minus(right).abs().gt('0.000001');
}

export function amountSumExceedsTolerance(values: Array<Amount | null>): boolean {
  return values.reduce((sum, value) => sum.plus(value ?? 0), new CreditDecimal(0))
    .abs().gt('0.000001');
}

/** Import residuals subtract exact numeric yuan before the credit write boundary. */
export function secondaryUsageFromYuan(totalYi: Amount, primaryYuan: Amount): number {
  return new CreditDecimal(totalYi).minus(new CreditDecimal(primaryYuan).div(100_000_000))
    .toDecimalPlaces(6).toNumber();
}

/** Numeric query results become numbers only at the existing JSON DTO boundary. */
export function amountNumber(value: Amount): number {
  return new CreditDecimal(value).toNumber();
}
