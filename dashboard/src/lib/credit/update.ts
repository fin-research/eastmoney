import { z } from "zod";

import {
  creditApplicationTypes,
  creditItemTypes,
  creditStatuses,
} from "./types.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须是完整的 YYYY-MM-DD 格式").refine((value) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return year > 0 && date.toISOString().slice(0, 10) === value;
}, "日期无效");
const nullableDate = isoDate.nullable();
const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullableAmount = z.number().finite().nullable();
const nullableLimit = z.number().finite().nonnegative().nullable();

const creditInstitutionChangesSchema = z.object({
  institutionType: z.string().trim().min(1).max(100),
  confidentialityStatus: z.boolean(),
  verified: z.boolean(),
  status: z.enum(creditStatuses),
  totalLimit: nullableLimit,
  effectiveDate: nullableDate,
  expiryDate: nullableDate,
  bankOffice: nullableText(500),
  applyingDepartment: nullableText(500),
  handler: nullableText(200),
  detail: nullableText(4_000),
  bondPreference: nullableText(4_000),
  notes: nullableText(8_000),
}).partial().strict();

const creditItemChangesSchema = z.object({
  type: z.enum(creditItemTypes),
  limitAmount: nullableLimit.optional(),
  usedAmount: nullableAmount.optional(),
  secondaryUsedAmount: nullableAmount.optional(),
  details: nullableText(4_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'other' && 'limitAmount' in value) {
    context.addIssue({ code: 'custom', path: ['limitAmount'], message: '其它仅记录已用和说明' });
  }
  if (value.type !== 'bond_investment' && value.type !== 'other' && 'details' in value) {
    context.addIssue({ code: 'custom', path: ['details'], message: '该授信分项不记录说明' });
  }
  if (["bond_investment", "yield_certificate", "interbank_lending"].includes(value.type) && "usedAmount" in value) {
    context.addIssue({ code: "custom", path: ["usedAmount"], message: "已用金额由线上数据计算；债券投资请登记二级买卖，收益凭证和拆借请维护负债数据" });
  }
  if ("secondaryUsedAmount" in value && value.type !== "bond_investment") {
    context.addIssue({ code: "custom", path: ["secondaryUsedAmount"], message: "仅债券投资可登记二级买卖" });
  }
  if (!("secondaryUsedAmount" in value) && !("limitAmount" in value) && !("usedAmount" in value) && !("details" in value)) {
    context.addIssue({
      code: "custom",
      message: "授信分项至少需要一个变更字段",
    });
  }
});

export const creditInstitutionUpdateSchema = z.object({
  operation: z.enum(creditApplicationTypes),
  reportDate: isoDate,
  viewDate: isoDate.optional(),
  viewFirstDate: isoDate.optional(),
  viewPreviousDate: isoDate.nullable().optional(),
  calendarMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  institutionName: z.string().trim().min(1).max(200),
  changes: z.object({
    institution: creditInstitutionChangesSchema.optional(),
    items: z.array(creditItemChangesSchema).max(creditItemTypes.length).optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const institutionChanges = value.changes.institution ?? {};
  const itemChanges = value.changes.items ?? [];
  if (!Object.keys(institutionChanges).length && !itemChanges.length) {
    context.addIssue({
      code: "custom",
      path: ["changes"],
      message: "至少需要一个授信变更字段",
    });
  }
  const itemTypes = new Set(itemChanges.map((item) => item.type));
  if (itemTypes.size !== itemChanges.length) {
    context.addIssue({
      code: "custom",
      path: ["changes", "items"],
      message: "同一授信分项不能重复更新",
    });
  }
});

export type CreditInstitutionChanges = z.infer<
  typeof creditInstitutionChangesSchema
>;

export type CreditItemChanges = z.infer<typeof creditItemChangesSchema>;

export type CreditInstitutionUpdateInput = z.infer<
  typeof creditInstitutionUpdateSchema
>;
