import { z } from 'zod';
import { dateSchema } from '../commentary.ts';

export const creditMaskedQuerySchema = z.object({
  view: z.literal('masked'),
  date: dateSchema.optional(),
  institutionId: z.string().refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n).optional(),
}).strict();
const amount = z.string().regex(/^-?\d+(\.\d+)?$/).nullable();
export const creditMaskedInstitutionSchema = z.object({
  institution_id: z.string().regex(/^[1-9]\d*$/),
  status: z.enum(['approved', 'applying']),
  effective_date: dateSchema.nullable(), expiry_date: dateSchema.nullable(),
  total_limit: amount, total_used: amount, total_available: amount, utilization_pct: amount,
  bond_investment_limit: amount, bond_primary_used: amount, bond_secondary_used: amount, bond_investment_used: amount,
  yield_certificate_limit: amount, yield_certificate_used: amount,
  interbank_lending_limit: amount, interbank_lending_used: amount,
  legal_overdraft_limit: amount, legal_overdraft_used: amount, other_used: amount,
  verified: z.boolean(),
}).strict();
export const creditMaskedReportSchema = z.object({
  reportDate: dateSchema, amountUnit: z.literal('亿元'),
  institutions: z.array(creditMaskedInstitutionSchema),
}).strict();
