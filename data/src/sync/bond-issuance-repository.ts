import type { DatabaseClient } from './postgres.ts';
import type { QuantInput } from './quant-input-contract.ts';
import { sourceDate } from './quant-input-contract.ts';

type Issue = { code: string; date: string; fields: Record<string, string | number> };

/** One row and one native column per issue fact. Missing incoming values leave existing facts intact. */
export async function upsertBondIssuance(client: DatabaseClient, rows: QuantInput[], insertOnly = false): Promise<number> {
  const issues = new Map<string, Issue>();
  for (const row of rows) {
    if (row.dataset !== 'issue' || !row.entityKey) throw new Error('Expected a bond issue input');
    const code = row.entityKey.toUpperCase();
    const issue = issues.get(code) ?? { code, date: row.observationDate, fields: {} };
    if (issue.date !== row.observationDate) throw new Error(`Conflicting issue dates: ${code}`);
    issue.fields[row.field] = row.numericValue ?? row.textValue!;
    issues.set(code, issue);
  }
  let changed = 0;
  await client.query('BEGIN');
  try {
  for (const { code, date, fields } of issues.values()) {
    const text = (key: string) => fields[key] == null ? null : String(fields[key]);
    const number = (key: string) => fields[key] == null ? null : Number(fields[key]);
    const yesNo = (key: string) => {
      const value = text(key);
      return value === '是' || value === '1' || value?.toLowerCase() === 'yes' ? true
        : value === '否' || value === '0' || value?.toLowerCase() === 'no' ? false : null;
    };
    if (!text('ISSUER_NAME')) throw new Error(`Issue missing issuer: ${code}`);
    const tenor = number('TENOR_YEAR') ?? number('BOND_EXPIRE_YEAR');
    const params = [code, date, text('ISSUER_NAME'), text('BOND_NAME_ABBR'), text('BOND_TYPE'),
      text('ISSUER_RATING'), text('BOND_RATING'), Number.isFinite(tenor) ? tenor : null,
      number('ACTUAL_ISSUE_SCALE'), text('PI_RATE_TYPE'), yesNo('IS_OEB'), yesNo('IS_GUARANTEE'),
      text('CROSS_MARKET_CODE'), number('TENOR_YEAR'), text('BOND_EXPIRE_YEAR'), number('PAYPERYEAR'),
      number('TOMRTY_YEAR'), text('DEC_TOMRTYYEAR1'), text('ORGFORM'), number('ISSUERATE_REFERENCE')];
    const result = await client.query(`INSERT INTO public.bond_issuance
      (bond_code,issue_date,issuer_name,short_name,bond_type,issuer_rating,bond_rating,
       original_tenor_years,issue_amount_100m,interest_rate_type,has_option,has_guarantee,
       cross_market_code,tenor_year,bond_expire_year,pay_per_year,tomrty_year,dec_tomrtyyear1,
       org_form,coupon_reference_pct)
      VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (bond_code) ${insertOnly ? 'DO NOTHING' : `DO UPDATE SET
        issue_date=EXCLUDED.issue_date,issuer_name=EXCLUDED.issuer_name,
        short_name=coalesce(EXCLUDED.short_name,bond_issuance.short_name),
        bond_type=coalesce(EXCLUDED.bond_type,bond_issuance.bond_type),
        issuer_rating=coalesce(EXCLUDED.issuer_rating,bond_issuance.issuer_rating),
        bond_rating=coalesce(EXCLUDED.bond_rating,bond_issuance.bond_rating),
        original_tenor_years=coalesce(EXCLUDED.original_tenor_years,bond_issuance.original_tenor_years),
        issue_amount_100m=coalesce(EXCLUDED.issue_amount_100m,bond_issuance.issue_amount_100m),
        interest_rate_type=coalesce(EXCLUDED.interest_rate_type,bond_issuance.interest_rate_type),
        has_option=coalesce(EXCLUDED.has_option,bond_issuance.has_option),
        has_guarantee=coalesce(EXCLUDED.has_guarantee,bond_issuance.has_guarantee),
        cross_market_code=coalesce(EXCLUDED.cross_market_code,bond_issuance.cross_market_code),
        tenor_year=coalesce(EXCLUDED.tenor_year,bond_issuance.tenor_year),
        bond_expire_year=coalesce(EXCLUDED.bond_expire_year,bond_issuance.bond_expire_year),
        pay_per_year=coalesce(EXCLUDED.pay_per_year,bond_issuance.pay_per_year),
        tomrty_year=coalesce(EXCLUDED.tomrty_year,bond_issuance.tomrty_year),
        dec_tomrtyyear1=coalesce(EXCLUDED.dec_tomrtyyear1,bond_issuance.dec_tomrtyyear1),
        org_form=coalesce(EXCLUDED.org_form,bond_issuance.org_form),
        coupon_reference_pct=coalesce(EXCLUDED.coupon_reference_pct,bond_issuance.coupon_reference_pct)`}`,
    params);
    changed += result.rowCount ?? 0;
  }
  await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  return changed;
}

export async function updateBondSpread(client: DatabaseClient, code: string, spread: number | null, invalid = false): Promise<number> {
  const result = await client.query(`UPDATE public.bond_issuance SET
    issue_spread_bp=coalesce($2,issue_spread_bp),issue_spread_invalid_code=issue_spread_invalid_code OR $3
    WHERE bond_code=$1`, [code.toUpperCase(), spread, invalid]);
  return result.rowCount ?? 0;
}

export async function updateBondPricing(client: DatabaseClient, code: string, fields: Record<string, unknown>, quarantined = false): Promise<number> {
  const text = (key: string) => fields[key] == null ? null : String(fields[key]);
  const date = (key: string) => sourceDate(text(key));
  const coupon = fields.TENDERFINALCOUPON == null ? null : Number(fields.TENDERFINALCOUPON);
  const values = [code.toUpperCase(), text('TENDERDATE'), Number.isFinite(coupon) ? coupon : null,
    text('ISSCORPCREDITRAT'), text('TENDERANNCDATE')];
  const result = quarantined
    ? await client.query(`UPDATE public.bond_issuance SET quarantine_tender_date=coalesce(quarantine_tender_date,$2),
        quarantine_final_coupon_pct=coalesce(quarantine_final_coupon_pct,$3),
        quarantine_issuance_rating=coalesce(quarantine_issuance_rating,$4),
        quarantine_announcement_date=coalesce(quarantine_announcement_date,$5)
        WHERE bond_code=$1`, values)
    : await client.query(`UPDATE public.bond_issuance SET
        tender_date=coalesce(tender_date,$2::date),final_coupon_pct=coalesce(final_coupon_pct,$3),
        issuance_rating=coalesce(issuance_rating,$4),
        tender_announcement_date=coalesce(tender_announcement_date,$5::date)
        WHERE bond_code=$1`, [code.toUpperCase(), date('TENDERDATE'), values[2], values[3], date('TENDERANNCDATE')]);
  return result.rowCount ?? 0;
}

export async function markPricingInvalidCode(client: DatabaseClient, code: string): Promise<void> {
  await client.query('UPDATE public.bond_issuance SET pricing_invalid_code=true WHERE bond_code=$1', [code.toUpperCase()]);
}

export async function updateBondPlacement(client: DatabaseClient, code: string, placement: string | null,
  maturity: string | null, checkedDate: string): Promise<number> {
  const result = await client.query(`UPDATE public.bond_issuance SET
    placement_type=coalesce(placement_type,$2),maturity_date=coalesce(maturity_date,$3::date),
    placement_checked_at=greatest(placement_checked_at,$4::date) WHERE bond_code=$1`, [code.toUpperCase(), placement, maturity, checkedDate]);
  return result.rowCount ?? 0;
}
