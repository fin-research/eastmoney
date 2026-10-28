import { z } from 'zod';

const id = z.union([z.string().min(1).max(256), z.number().int()]);
const scalar = z.union([z.string().max(1024), z.number().finite()]);
const date = z.iso.date();
const decimal = scalar.refine(value => /^\d+(?:\.\d+)?$/.test(String(value)) && Number(value) > 0 && Number.isFinite(Number(value)), '应为正数');
const days = z.union([z.number().int().positive().max(36600), z.string().regex(/^[1-9]\d{0,4}$/)]);
const optionalScalar = scalar.nullish();

// Fixed DTOs: upstream envelopes, authentication and arbitrary fields never cross the adapter.
export const camelImportRecordSchema = z.object({
  serialNo: z.string().regex(/^IBO\d{14}$/),
  busiDate: date,
  ourpartyName: z.string().min(1).max(256),
  counterpartyName: z.string().min(1).max(256),
  matchAmount: decimal,
  matchTime: date,
  firstSettleDate: date,
  interestRate: decimal,
  totalInterest: scalar.refine(value => /^\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value))),
  expireAmount: decimal,
  counterpartyAccount: z.string().min(1).max(256),
  ourpartyAccount: z.string().min(1).max(256),
  days,
  daysPurpose: days,
  totalInterestRedFlg: z.boolean().optional(),
  // Keys verified against the office parser on 2026-10-19; preserve settlement and trader information.
  contractNo: optionalScalar, counterpartyTrader: optionalScalar, ourTrader: optionalScalar,
  counterpartyBankBranchName: optionalScalar, counterpartyBankBranchNo: optionalScalar,
  counterpartyBankName: optionalScalar, ourpartyBankBranchName: optionalScalar,
  ourpartyBankBranchNo: optionalScalar, ourpartyBankName: optionalScalar,
  setdays: optionalScalar, tradeDirectionName: optionalScalar,
  daysPurposeRedFlag: z.literal(false).optional(), daysRedFlg: z.literal(false).optional(),
  expireAmountRedFlg: z.literal(false).optional(), serialNoRedFlg: z.literal(false).optional(),
});
export const camelBorrowingSchema = z.object({
  id, serialNo: z.string().min(1).max(128), busiDate: z.string(),
  ourpartyName: optionalScalar, counterpartyName: optionalScalar,
  matchAmount: optionalScalar, matchTime: optionalScalar, firstSettleDate: z.string(),
  expireAmount: scalar, interestRate: optionalScalar, totalInterest: optionalScalar,
  days: optionalScalar, daysPurpose: optionalScalar,
  financingCode: optionalScalar, hid: id.nullish(), allocateReviewStatus: optionalScalar,
  dataSource: optionalScalar, paymentStatus: optionalScalar,
  disburseAccountId: optionalScalar, disburseAccount: optionalScalar,
  disburseAccountBank: optionalScalar, disburseAccountName: optionalScalar,
  disburseAccountBranch: optionalScalar, disburseAccountBranchNo: optionalScalar,
});
export const camelBorrowingPageSchema = z.object({
  records: z.array(camelBorrowingSchema).max(100), total: z.coerce.number().int().min(0).max(100_000),
});
export const camelDraftSchema = z.object({
  hid: id, reservationId: optionalScalar, remark: z.string(), repaymentId: id.nullish(),
  reviewStatus: scalar, status: scalar,
  attachmentList: z.array(z.object({ id })).max(100),
});
export const camelAttachmentSchema = z.object({ id });
export const camelDraftRequestSchema = z.object({
  date, serialNo: z.string().regex(/^IBO\d{14}$/), attachmentIds: z.array(id).min(1).max(20),
}).strict();
export type CamelBorrowing = z.infer<typeof camelBorrowingSchema>;
export type CamelImportRecord = z.infer<typeof camelImportRecordSchema>;
