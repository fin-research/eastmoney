import { amountsDiffer, amountSumExceedsTolerance, subtractAmounts as differenceAmount, sumAmounts } from './amounts.ts';
import { SSF, read, utils } from "xlsx";

import {
  creditItemTypes,
  type ConfidentialityStatus,
  type CreditItemType,
  type CreditStatus,
  type ParsedCreditInstitution,
  type ParsedCreditItem,
  type ParsedCreditWorkbook,
} from "./types.ts";

const SOURCE_SHEET = "授信一览表" as const;

const itemColumns: Record<CreditItemType, {
  limit: number | null;
  used: number;
  remaining: number | null;
  details?: number;
}> = {
  bond_investment: { limit: 9, used: 10, remaining: 11 },
  yield_certificate: { limit: 12, used: 13, remaining: 14 },
  legal_overdraft: { limit: 15, used: 16, remaining: 17 },
  interbank_lending: { limit: 21, used: 22, remaining: 23 },
  other: { limit: null, used: 24, remaining: null, details: 25 },
};

export class CreditWorkbookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditWorkbookParseError";
  }
}

export function parseCreditWorkbook(
  input: Uint8Array,
  options: { reportDate: string; originalFileName: string },
): ParsedCreditWorkbook {
  assertIsoDate(options.reportDate);
  const workbook = read(input, {
    type: "array",
    cellDates: false,
    cellFormula: true,
  });
  const sheet = workbook.Sheets[SOURCE_SHEET];
  if (!sheet) {
    throw new CreditWorkbookParseError(`缺少“${SOURCE_SHEET}”Sheet`);
  }
  const rows = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  }) as unknown[][];
  validateHeaders(rows);

  const warnings: string[] = [];
  const institutions: ParsedCreditInstitution[] = [];
  const institutionNames = new Set<string>();
  let institutionType = "未分类";
  let unclassifiedCount = 0;

  for (let rowIndex = 3; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const currentType = cleanText(row[1]);
    if (currentType === "合计") institutionType = "未分类";
    else if (currentType) institutionType = currentType;
    const institutionName = cleanText(row[2]);
    if (!institutionName || institutionName === ".") continue;
    if (institutionNames.has(institutionName)) {
      throw new CreditWorkbookParseError(
        `“${institutionName}”在授信一览表中重复，无法作为跨期比较键`,
      );
    }
    institutionNames.add(institutionName);

    const sourceRow = rowIndex + 1;
    const items = creditItemTypes.map((type) => parseItem(row, type));
    // Legacy Excel keeps its original columns; retired margin-rights amounts belong to other.
    const other = items.find(item => item.type === 'other')!;
    // Legacy column 18 was a separate margin-rights limit; other is now usage-only.
    const marginUsed = finiteNumber(row[19]);
    if (marginUsed != null) other.usedAmount = sumAmounts([other.usedAmount, marginUsed]);
    const totalLimit = finiteNumber(row[6]);
    const reportedTotalUsed = finiteNumber(row[7]);
    const totalUsed = sumAmounts(items.map((item) => item.usedAmount));
    const reportedRemaining = finiteNumber(row[8]);
    const totalRemaining = subtractAmounts(totalLimit, totalUsed);
    const status = parseStatus(row[4], row[5]);
    const effectiveDate = excelDate(row[26]);
    const expiryDate = excelDate(row[27]);
    if (row[26] != null && cleanText(row[26]) !== "/" && !effectiveDate) {
      warnings.push(`第${sourceRow}行“${institutionName}”授信生效日无法识别`);
    }
    if (row[27] != null && cleanText(row[27]) !== "/" && !expiryDate) {
      warnings.push(`第${sourceRow}行“${institutionName}”授信到期日无法识别`);
    }
    if (status === "approved" && totalLimit == null) {
      warnings.push(`第${sourceRow}行“${institutionName}”已获批但授信总额为空`);
    }
    if (
      totalLimit != null &&
      reportedTotalUsed != null &&
      reportedRemaining != null &&
      amountSumExceedsTolerance([totalLimit, -reportedTotalUsed, -reportedRemaining])
    ) {
      warnings.push(`第${sourceRow}行“${institutionName}”总额、已用和剩余不勾稽`);
    }
    if (reportedTotalUsed != null && amountsDiffer(reportedTotalUsed, totalUsed)) {
      warnings.push(`第${sourceRow}行“${institutionName}”总已用与分项已用不一致：原表${reportedTotalUsed}亿元，分项合计${totalUsed}亿元，差额${sumAmounts([reportedTotalUsed, -totalUsed])}亿元；按分项合计导入`);
    }

    if (institutionType === "未分类") unclassifiedCount += 1;
    institutions.push({
      institutionType,
      institutionName,
      confidentialityStatus: parseConfidentiality(row[3]),
      status,
      totalLimit,
      totalUsed,
      totalRemaining,
      effectiveDate,
      expiryDate,
      bankOffice: cleanText(row[28]),
      applyingDepartment: cleanText(row[29]),
      handler: cleanText(row[30]),
      detail: cleanText(row[31]),
      bondPreference: cleanText(row[32]),
      notes: cleanText(row[33]),
      items,
    });
  }

  if (institutions.length === 0) {
    throw new CreditWorkbookParseError("授信一览表没有可导入的机构记录");
  }
  if (unclassifiedCount > 0) {
    warnings.push(`${unclassifiedCount}家机构未标记机构性质，按“未分类”导入`);
  }

  const approved = institutions.filter((institution) => institution.status === "approved");
  const totalLimit = sumAmounts(approved.map((institution) => institution.totalLimit));
  const totalUsed = sumAmounts(approved.map((institution) => institution.totalUsed));
  const totalAvailable = sumAmounts(
    approved.map((institution) => availableAmount(institution.totalLimit, institution.totalUsed)),
  );

  return {
    reportDate: options.reportDate,
    originalFileName: options.originalFileName,
    sourceSheet: SOURCE_SHEET,
    institutions,
    approvedCount: approved.length,
    totalLimit,
    totalUsed,
    totalAvailable,
    weeklyApprovedCount: approved.length,
    weeklyTotalLimit: totalLimit,
    weeklyTotalUsed: totalUsed,
    weeklyTotalAvailable: totalAvailable,
    warnings,
  };
}

function parseItem(row: unknown[], type: CreditItemType): ParsedCreditItem {
  const columns = itemColumns[type];
  return {
    type,
    limitAmount: columns.limit == null ? null : finiteNumber(row[columns.limit]),
    usedAmount: finiteNumber(row[columns.used]),
    remainingAmount:
      columns.remaining == null ? null : finiteNumber(row[columns.remaining]),
    details: columns.details == null ? null : cleanText(row[columns.details]),
  };
}

function validateHeaders(rows: unknown[][]): void {
  const expected: Array<[number, number, string]> = [
    [1, 2, "银行名称"],
    [1, 6, "授信额度\n(亿元)"],
    [2, 6, "总额"],
    [1, 9, "债券投资额度(亿元)"],
    [1, 12, "收益凭证额度(亿元)"],
    [1, 21, "同业拆借额度(亿元)"],
    [1, 24, "其它(亿元)"],
    [1, 26, "授信生效日"],
    [1, 27, "授信到期日"],
  ];
  for (const [row, column, value] of expected) {
    if (cleanText(rows[row]?.[column]) !== value) {
      throw new CreditWorkbookParseError(
        `授信一览表列结构已变化：${cellAddress(row, column)} 应为“${value}”`,
      );
    }
  }
}

function parseStatus(approved: unknown, applying: unknown): CreditStatus {
  if (truthyFlag(approved)) return "approved";
  if (truthyFlag(applying)) return "applying";
  return "revoked";
}

function parseConfidentiality(value: unknown): ConfidentialityStatus {
  const text = cleanText(value);
  return value === true || value === 1 || text === "是" || text === "已签署" || text === "signed";
}

function truthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const text = cleanText(value)?.toLocaleLowerCase("zh-CN");
  return text === "1" || text === "是" || text === "√" || text === "已获批";
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized || normalized === "/" || normalized === "-") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function excelDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = SSF.parse_date_code(value);
    if (!parsed) return null;
    return isoDate(parsed.y, parsed.m, parsed.d);
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  const text = cleanText(value);
  if (!text || text === "/") return null;
  const full = text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (full) return isoDate(Number(full[1]), Number(full[2]), Number(full[3]));
  const short = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (short) return isoDate(2000 + Number(short[3]), Number(short[1]), Number(short[2]));
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).replaceAll("\r\n", "\n").trim();
  return text || null;
}

function subtractAmounts(left: number | null, right: number | null): number | null {
  if (left == null || right == null) return null;
  return differenceAmount(left, right);
}

function availableAmount(limit: number | null, used: number | null): number | null {
  if (limit == null) return null;
  return differenceAmount(limit, used ?? 0);
}

function cellAddress(row: number, column: number): string {
  return `${utils.encode_col(column)}${row + 1}`;
}

function assertIsoDate(value: string): void {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (
    !match ||
    isoDate(Number(match[1]), Number(match[2]), Number(match[3])) !== value
  ) {
    throw new CreditWorkbookParseError("报表日必须是有效的 YYYY-MM-DD 日期");
  }
}
