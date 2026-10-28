import { z } from "zod";

import { ApiError } from "./http";

export function isMissingValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && ["", "--"].includes(value.trim()));
}

const finiteNumber = z.number().finite();
const nullableNumericValue = z.preprocess(
  (value) => isMissingValue(value) ? null : typeof value === "string" ? value.trim() : value,
  z.codec(
    z.union([
      finiteNumber,
      z.string().trim().regex(/^-?\d+(?:\.\d+)?$/),
      z.literal("--"),
      z.literal(""),
      z.null(),
    ]),
    finiteNumber.nullable(),
    {
      decode: (value) => value === null || value === "--" || value === ""
        ? null
        : Number(value),
      encode: (value) => value,
    },
  ),
);
const identifier = z.codec(
  z.union([z.string().min(1), z.number().int().finite()]),
  z.string().min(1),
  {
    decode: String,
    encode: (value) => value,
  },
);
const dateOnly = z.codec(
  z.string().regex(/^\d{4}-\d{2}-\d{2}(?:\s.*)?$/),
  z.string().date(),
  {
    decode: (value) => value.slice(0, 10),
    encode: (value) => value,
  },
);
const nullableNumber = nullableNumericValue.optional();
const optionalNumber = nullableNumericValue.optional();
const optionalString = z.string().nullish();
const nullableString = z.preprocess(
  (value) => value === undefined || value === "" || value === "--" ? null : value,
  z.string().min(1).nullable(),
);
const epochMilliseconds = z.codec(
  z.union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^\d+$/),
  ]),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  {
    decode: Number,
    encode: (value) => value,
  },
);

export const omoOperationSchema = z.object({
  operationDate: z.string().date(),
  operationName: nullableString,
  duration: nullableString,
  interestRate: nullableNumericValue,
  operationAmount: nullableNumericValue,
});

export const cfetsRateSchema = z.object({
  bondCode: z.string().min(1),
  weightedYield: nullableNumericValue,
  weightedYieldUpDownValueBp: nullableNumericValue,
});

export const cfetsHistorySchema = z.object({
  bondCode: z.string().min(1),
  capitalTime: epochMilliseconds,
  weightedYield: nullableNumericValue,
  weightedAvgRate: nullableNumericValue,
  lastPrice: nullableNumericValue,
  weightedYieldUpDownValueBp: nullableNumericValue,
});

export const cfetsHistoryPageSchema = z.object({
  hasNextPage: z.boolean(),
  rows: z.array(cfetsHistorySchema),
});

export const governmentBondSchema = z.object({
  ordinateName: nullableString,
  abscissaName: nullableString,
  bondCode: z.string().min(1),
  tradeNum: nullableNumericValue,
  yield: nullableNumericValue,
  yieldSubYtdCloseBp: nullableNumericValue,
});

export const futuresQuoteSchema = z.object({
  contractCode: z.string().min(1),
  lastPrice: nullableNumericValue,
  upDownValuePct: nullableNumericValue,
});

export const marginBalanceSchema = z.object({
  DIM_DATE: dateOnly,
  TOTAL_RZRQYE: nullableNumericValue,
  TOTAL_RZYE: nullableNumericValue,
  TOTAL_RQYE: nullableNumericValue,
});

export const primaryIssueSchema = z.object({
  bidStartDate: optionalString,
  issueStartDate: optionalString,
  biddingTime: optionalString,
  comShortName: optionalString,
  issuerShortName: optionalString,
  issuerShortNameCn: optionalString,
  comFullName: optionalString,
  issuerName: optionalString,
  publicOffering: z.union([z.string(), finiteNumber]).nullish(),
  publicOfferingText: optionalString,
  offeringType: optionalString,
  issueWay: optionalString,
  raisingMode: optionalString,
  bondTypeText: optionalString,
  bondShortName: nullableString,
  issueTenor: optionalString,
  planIssueAmount: optionalNumber,
  issueCouponRate: nullableNumber,
});

export const brokerBondRegistrationSchema = z.object({
  projectName: z.string().min(1),
  issuerName: z.string().min(1),
  status: z.string().min(1),
  variety: z.string().min(1),
  amountYi: nullableNumericValue,
  region: nullableString,
  industry: nullableString,
  leadUnderwriter: nullableString,
  noticeNumber: nullableString,
  venue: nullableString,
  registrationOrFiling: nullableString,
  updateDate: dateOnly,
});

export const brokerBondRegistrationPageSchema = z.object({
  hasNextPage: z.boolean(),
  rows: z.array(brokerBondRegistrationSchema),
});

export const todayTradeSchema = z.object({
  bondUniCode: identifier,
  remainingTenor: nullableString,
  cbYte: nullableNumber,
  tradeYield: nullableNumericValue,
  tradeYieldSubCb: nullableNumber,
});

export const favoriteQuoteSchema = z.object({
  bondUniCode: identifier,
  bondShortName: optionalString,
  remainingTenor: nullableString,
  remainingTenorDay: optionalNumber,
  cbYield: nullableNumber,
  bidYield: nullableNumber,
  bidEntryPrice: nullableNumber,
  ofrYield: nullableNumber,
  ofrEntryPrice: nullableNumber,
  tradeEntryPrice: nullableNumber,
  tradeYieldSubCb: nullableNumber,
});

export const bondInfoSchema = z.object({
  bondUniCode: identifier,
  bondShortName: nullableString,
  comShortName: nullableString,
  bondType: nullableNumericValue,
  bondOfferingType: nullableNumericValue,
  sciTechInnoBondStatus: nullableNumericValue,
});

export const newsSummarySchema = z.object({
  sentimentId: z.string().min(1),
  newsId: optionalString,
  title: z.string().min(1),
  time: z.string().datetime({ offset: true }),
  tags: z.array(z.string()).default([]),
  important: z.boolean().optional(),
});

export const newsDetailSchema = newsSummarySchema.extend({
  content: z.string().default(""),
  link: z.url().optional(),
});

// List mode remains summary-only unless detail=true was requested.
export const newsListItemSchema = newsSummarySchema.extend({
  content: z.string().optional(),
  link: z.url().optional(),
});

export const wechatArticleSchema = z.object({
  sentimentId: z.string().min(1),
  title: z.string().min(1),
  accountName: z.string().min(1),
  time: z.string().datetime({ offset: true }),
  url: z.url(),
});

const industrySchema = z.object({
  name: z.string().min(1),
  change_pct: nullableNumericValue,
  market_cap_yuan: nullableNumericValue,
});
const equitySchema = z.object({
  name: z.string().min(1),
  close: nullableNumericValue,
  change_pct: nullableNumericValue,
});

export const industrySnapshotSchema = z.object({
  dataDate: z.string().date(),
  industries: z.array(industrySchema),
  equities: z.array(equitySchema),
  turnoverYi: finiteNumber.nullable(),
  turnoverChangeYi: finiteNumber.nullable(),
  tradingDates: z.array(z.string().date()),
});

export const tradingDaySchema = z.object({
  date: z.string().date(),
  isTradingDay: z.boolean(),
  previousTradingDate: z.string().date(),
});

export const stockSummarySchema = z.object({
  title: z.string().min(1),
  time: z.string().datetime({ offset: true }).nullable(),
  paragraphs: z.array(z.string()),
  summary: z.string(),
});

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}

function receivedValue(value: unknown): {
  receivedType: string;
  receivedValue?: string | number | boolean | null;
} {
  if (value === null) return { receivedType: "null", receivedValue: null };
  if (Array.isArray(value)) return { receivedType: "array" };
  if (typeof value === "string") {
    return {
      receivedType: "string",
      receivedValue: value.length > 80 ? `${value.slice(0, 80)}…` : value,
    };
  }
  if (typeof value === "number") {
    return {
      receivedType: "number",
      receivedValue: Number.isFinite(value) ? value : String(value),
    };
  }
  if (typeof value === "boolean") {
    return { receivedType: "boolean", receivedValue: value };
  }
  return { receivedType: typeof value };
}

function schemaFailure(label: string, value: unknown, error: z.ZodError): never {
  const issues = error.issues.slice(0, 8).map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
    ...receivedValue(valueAtPath(value, issue.path)),
  }));
  console.error(JSON.stringify({
    event: "upstream_schema_mismatch",
    resource: label,
    issues,
  }));
  throw new ApiError(503, `${label}上游数据格式异常`, {
    code: "UPSTREAM_SCHEMA_MISMATCH",
    source: label,
    stage: "response_validation",
    issues,
  });
}

export function parseRows<S extends ObjectSchema>(
  schema: S,
  value: unknown,
  label: string,
): Array<z.output<S>> {
  if (value == null) return [];
  if (Array.isArray(value)) value = value.filter((row) => row != null &&
    !(typeof row === "object" && !Array.isArray(row) && Object.values(row).every(isMissingValue)));
  const result = z.array(schema).safeParse(value);
  if (result.success) return result.data;
  // Only missing values may remove an unidentifiable row. Corrupt non-empty
  // values remain errors, so an invalid payload cannot masquerade as no data.
  if (Array.isArray(value)) {
    const missingRows = new Set(result.error.issues.filter((issue) =>
      typeof issue.path[0] === "number" && isMissingValue(valueAtPath(value, issue.path)))
      .map((issue) => issue.path[0]));
    if (missingRows.size) {
      console.warn(JSON.stringify({ event: "upstream_empty_rows", resource: label, rows: missingRows.size }));
      return parseRows(schema, value.filter((_, index) => !missingRows.has(index)), label);
    }
  }
  return schemaFailure(label, value, result.error);
}

export function parseObject<S extends ObjectSchema>(
  schema: S,
  value: unknown,
  label: string,
): z.output<S> {
  const result = schema.safeParse(value);
  return result.success ? result.data : schemaFailure(label, value, result.error);
}

const objectEnvelopeSchema = z.record(z.string(), z.unknown());

export function objectProperty(
  value: unknown,
  property: string,
  label: string,
): unknown {
  if (value == null) return undefined;
  const result = objectEnvelopeSchema.safeParse(value);
  if (!result.success) return schemaFailure(label, value, result.error);
  return result.data[property];
}

function selectedFields(
  raw: string | null,
  allowed: readonly string[],
): string[] {
  if (raw === null) return [...allowed];
  const fields = [...new Set(raw.split(",").map((field) => field.trim()).filter(Boolean))];
  if (fields.length === 0) throw new ApiError(422, "fields 不能为空");
  const unknown = fields.filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw new ApiError(
      422,
      `fields 包含未知字段 ${JSON.stringify(unknown)}；允许 ${JSON.stringify(allowed)}`,
    );
  }
  return fields;
}

function project(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((field) =>
      value[field] === undefined ? [] : [[field, value[field]] as const],
    ),
  );
}

export function projectRows<S extends ObjectSchema>(
  schema: S,
  rows: Array<z.output<S>>,
  rawFields: string | null,
): Array<Record<string, unknown>> {
  const fields = selectedFields(rawFields, Object.keys(schema.shape));
  return rows.map((row) => project(row, fields));
}

export function projectObject<S extends ObjectSchema>(
  schema: S,
  value: z.output<S>,
  rawFields: string | null,
): Record<string, unknown> {
  return project(value, selectedFields(rawFields, Object.keys(schema.shape)));
}

export const chinamoneyShiborSchema = z.object({
  publishDate: z.string().date(),
  publishedAt: z.string().datetime({ offset: true }),
  tenor: z.enum(['O/N', '1W', '2W', '1M', '3M', '6M', '9M', '1Y']),
  rate: z.number().finite(),
});
