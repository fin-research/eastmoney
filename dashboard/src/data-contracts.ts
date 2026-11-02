import { z } from "zod";

function isMissingValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && ["", "--"].includes(value.trim()));
}
const finiteNumber = z.number().finite();
const nullableNumericValue = z.preprocess(
  (value) => isMissingValue(value) ? null : typeof value === "string" ? value.trim() : value,
  z
    .union([
      finiteNumber,
      z.string().trim().regex(/^-?\d+(?:\.\d+)?$/),
      z.literal("--"),
      z.literal(""),
      z.null(),
    ])
    .transform((value) => value === null || value === "--" || value === ""
      ? null
      : Number(value)),
);
const identifier = z
  .union([z.string().min(1), z.number().int().finite()])
  .transform(String);

function sparseList<T extends z.ZodType>(rows: z.ZodArray<T>): z.ZodType<z.output<typeof rows>> {
  return z.preprocess((value) => {
    if (value == null) return [];
    if (!Array.isArray(value)) return value;
    return value.filter((row) => {
      if (row == null || (typeof row === "object" && !Array.isArray(row) && Object.values(row).every(isMissingValue))) return false;
      const parsed = rows.element.safeParse(row);
      if (parsed.success) return true;
      return !parsed.error.issues.every((issue) => {
        let received: unknown = row;
        for (const key of issue.path) {
          received = received !== null && typeof received === "object" ? Reflect.get(received, key) : undefined;
        }
        return isMissingValue(received);
      });
    });
  }, rows);
}

export const omoOperationSchema = z.object({
  operationDate: z.string(),
  operationName: z.string().nullish(),
  duration: z.string().nullish(),
  interestRate: nullableNumericValue,
  operationAmount: nullableNumericValue,
});
export const omoOperationsSchema = sparseList(z.array(omoOperationSchema));

export const cfetsRateSchema = z.object({
  bondCode: z.string(),
  weightedYield: nullableNumericValue,
  weightedYieldUpDownValueBp: nullableNumericValue,
});
export const cfetsRatesSchema = sparseList(z.array(cfetsRateSchema));

export const governmentBondSchema = z.object({
  ordinateName: z.string().nullish(),
  abscissaName: z.string().nullish(),
  bondCode: z.string(),
  tradeNum: nullableNumericValue,
  yield: nullableNumericValue,
  yieldSubYtdCloseBp: nullableNumericValue,
});
export const governmentBondsSchema = sparseList(z.array(governmentBondSchema));

export const futuresQuoteSchema = z.object({
  contractCode: z.string(),
  lastPrice: nullableNumericValue,
  upDownValuePct: nullableNumericValue,
});
export const futuresQuotesSchema = sparseList(z.array(futuresQuoteSchema));

export const marginBalanceSchema = z.object({
  DIM_DATE: z.string(),
  TOTAL_RZRQYE: nullableNumericValue,
  TOTAL_RZYE: nullableNumericValue,
  TOTAL_RQYE: nullableNumericValue,
});
export const marginBalancesSchema = sparseList(z.array(marginBalanceSchema));

export const primaryIssueSchema = z.object({
  bidStartDate: z.string().nullish(),
  issueStartDate: z.string().nullish(),
  biddingTime: z.string().nullish(),
  comShortName: z.string().nullish(),
  issuerShortName: z.string().nullish(),
  issuerShortNameCn: z.string().nullish(),
  comFullName: z.string().nullish(),
  issuerName: z.string().nullish(),
  publicOffering: z.union([z.string(), finiteNumber]).nullish(),
  publicOfferingText: z.string().nullish(),
  offeringType: z.string().nullish(),
  issueWay: z.string().nullish(),
  raisingMode: z.string().nullish(),
  bondTypeText: z.string().nullish(),
  bondShortName: z.string().nullish(),
  issueTenor: z.string().nullish(),
  planIssueAmount: nullableNumericValue.optional(),
  issueCouponRate: nullableNumericValue.optional(),
});
export const primaryIssuesSchema = sparseList(z.array(primaryIssueSchema));

export const todayTradeSchema = z.object({
  bondUniCode: identifier,
  remainingTenor: z.string().nullish(),
  cbYte: nullableNumericValue.optional(),
  tradeYield: nullableNumericValue,
  tradeYieldSubCb: nullableNumericValue.optional(),
});
export const todayTradesSchema = sparseList(z.array(todayTradeSchema));

export const favoriteQuoteSchema = z.object({
  bondUniCode: identifier,
  bondShortName: z.string().nullish(),
  remainingTenor: z.string().nullish(),
  remainingTenorDay: nullableNumericValue.optional(),
  cbYield: nullableNumericValue.optional(),
  bidYield: nullableNumericValue.optional(),
  bidEntryPrice: nullableNumericValue.optional(),
  ofrYield: nullableNumericValue.optional(),
  ofrEntryPrice: nullableNumericValue.optional(),
  tradeEntryPrice: nullableNumericValue.optional(),
  tradeYieldSubCb: nullableNumericValue.optional(),
});
export const favoriteQuotesSchema = sparseList(z.array(favoriteQuoteSchema));

export const bondInfoSchema = z.object({
  bondUniCode: identifier,
  bondShortName: z.string().nullish(),
  comShortName: z.string().nullish(),
  bondType: nullableNumericValue,
  bondOfferingType: nullableNumericValue,
  sciTechInnoBondStatus: nullableNumericValue,
});
export const bondInfosSchema = sparseList(z.array(bondInfoSchema));

const equitySchema = z.object({
  name: z.string(),
  close: nullableNumericValue,
  change_pct: nullableNumericValue,
});
const industrySchema = z.object({
  name: z.string(),
  change_pct: nullableNumericValue,
  market_cap_yuan: nullableNumericValue,
});
export const industrySnapshotSchema = z.object({
  dataDate: z.string(),
  equities: z.array(equitySchema),
  industries: z.array(industrySchema),
  turnoverYi: finiteNumber.nullable(),
  turnoverChangeYi: finiteNumber.nullable(),
});

export const tradingDaySchema = z.object({
  date: z.string(),
  isTradingDay: z.boolean(),
  previousTradingDate: z.string(),
});

export const stockSummarySchema = z.object({
  title: z.string(),
  time: z.string().nullable(),
  paragraphs: z.array(z.string()),
});

export type OmoOperation = z.infer<typeof omoOperationSchema>;
export type CfetsRate = z.infer<typeof cfetsRateSchema>;
export type GovernmentBond = z.infer<typeof governmentBondSchema>;
export type FuturesQuote = z.infer<typeof futuresQuoteSchema>;
export type MarginBalance = z.infer<typeof marginBalanceSchema>;
export type PrimaryIssue = z.infer<typeof primaryIssueSchema>;
export type TodayTrade = z.infer<typeof todayTradeSchema>;
export type FavoriteQuote = z.infer<typeof favoriteQuoteSchema>;
export type BondInfo = z.infer<typeof bondInfoSchema>;
export type IndustrySnapshot = z.infer<typeof industrySnapshotSchema>;
export type StockSummary = z.infer<typeof stockSummarySchema>;

export const shiborRatesSchema = z.array(z.object({
  publishDate: z.string().date(), publishedAt: z.string().datetime({ offset: true }),
  tenor: z.enum(['O/N', '1W', '2W', '1M', '3M', '6M', '9M', '1Y']), rate: z.number().finite(),
})).max(8);
export type ShiborRate = z.infer<typeof shiborRatesSchema>[number];

// CAMEL adapter: smallest DTOs consumed by the interbank ledger client.
const interbankId = z.union([z.string().min(1), z.number().finite()]);
const interbankScalar = z.union([z.string(), z.number().finite()]).nullish();
export const interbankPageSchema = z.object({
  records:z.array(z.object({id:interbankId,serialNo:z.string(),busiDate:z.string(),ourpartyName:interbankScalar,counterpartyName:interbankScalar,matchAmount:interbankScalar,matchTime:interbankScalar,firstSettleDate:z.string(),expireAmount:interbankScalar,financingCode:interbankScalar,hid:interbankId.nullish(),allocateReviewStatus:interbankScalar})),
  total:z.number().int().nonnegative(),
});
export const interbankParseSchema = z.object({status:z.string(),data:z.array(z.record(z.string(),z.unknown())),totalNum:z.number().int(),warnings:z.array(z.unknown()).optional()});
export const interbankAttachmentSchema = z.object({id:interbankId});
export const interbankSavedSchema = z.object({saved:z.literal(true)});
export const interbankDraftSavedSchema = z.object({hid:interbankId});
export const interbankDraftSchema = z.object({hid:interbankId,reservationId:interbankScalar,remark:z.string(),repaymentId:interbankId.nullish(),reviewStatus:interbankScalar,status:interbankScalar,attachmentList:z.array(z.object({id:interbankId}))});
