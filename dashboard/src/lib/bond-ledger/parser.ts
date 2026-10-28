import type {
  LedgerPerformanceRow,
  LedgerPositionRow,
  ParsedBondLedger,
} from "./types";

const PERFORMANCE_COLUMNS = {
  date: 0,
  principal: 2,
  timeWeightedPrincipal: 5,
  marketValue: 9,
  leverage: 12,
  modifiedDuration: 19,
  dailyRevenue: 20,
  cumulativeProfit: 30,
  ytdAnnualizedReturn: 36,
  ytdExTaxAnnualizedReturn: 42,
} as const;

const REQUIRED_POSITION_HEADERS = [
  "报表日期",
  "债券代码",
  "交易市场",
  "债券名称",
  "债券分类",
  "收益率变动(BP)",
  "剩余期限（年）",
  "到期日",
  "今日持仓量",
  "昨日持仓量",
  "当日买量",
  "当日卖量",
  "当日到期量",
  "票面利率",
  "今日估值收益率",
  "含免税报表收益率",
  "估值全价",
  "DV01",
  "全价市值",
  "当日损益",
  "全年损益",
  "全价成本",
] as const;

const AVAILABLE_POSITION_OPTIONAL_HEADERS = new Set([
  "收益率变动(BP)",
  "今日估值收益率",
  "DV01",
]);

const PERFORMANCE_SHEET_NAME = "二级池累计收益";
const TRANSACTION_POSITION_SHEET_NAME = "当日交易户数据";
const AVAILABLE_POSITION_SHEET_NAME = "当日可供户数据";

type Matrix = unknown[][];

export class BondLedgerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BondLedgerParseError";
  }
}

export async function parseBondLedgerFile(file: File): Promise<ParsedBondLedger> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new BondLedgerParseError("仅支持 .xlsx 标准台账");
  }
  const { read, utils } = await import("xlsx");
  return parseBondLedgerWorkbook(read(await file.arrayBuffer(), {
    cellDates: true,
    cellFormula: false,
  }), utils);
}

export async function parseBondLedgerBuffer(
  buffer: ArrayBuffer,
): Promise<ParsedBondLedger> {
  const { read, utils } = await import("xlsx");
  return parseBondLedgerWorkbook(read(buffer, {
    cellDates: true,
    cellFormula: false,
  }), utils);
}

function parseBondLedgerWorkbook(
  workbook: import("xlsx").WorkBook,
  utils: typeof import("xlsx").utils,
): ParsedBondLedger {
  if (workbook.SheetNames.length < 2) {
    throw new BondLedgerParseError("台账至少需要前两张工作表");
  }
  const performanceSheet = findWorkbookSheet(
    workbook,
    PERFORMANCE_SHEET_NAME,
  ) ?? workbook.Sheets[workbook.SheetNames[0] ?? ""];
  const transactionPositionSheet = findWorkbookSheet(
    workbook,
    TRANSACTION_POSITION_SHEET_NAME,
  ) ?? workbook.Sheets[workbook.SheetNames[1] ?? ""];
  const availablePositionSheet = findWorkbookSheet(
    workbook,
    AVAILABLE_POSITION_SHEET_NAME,
  );
  if (!performanceSheet || !transactionPositionSheet) {
    throw new BondLedgerParseError("无法读取台账前两张工作表");
  }
  const matrixOptions = { header: 1 as const, raw: true, defval: null };
  return parseBondLedgerMatrices(
    utils.sheet_to_json(performanceSheet, matrixOptions) as Matrix,
    utils.sheet_to_json(transactionPositionSheet, matrixOptions) as Matrix,
    availablePositionSheet
      ? [utils.sheet_to_json(availablePositionSheet, matrixOptions) as Matrix]
      : [],
  );
}

export function parseBondLedgerMatrices(
  performanceMatrix: Matrix,
  positionMatrix: Matrix,
  additionalPositionMatrices: Matrix[] = [],
): ParsedBondLedger {
  validatePerformanceHeader(performanceMatrix);
  const performance = parsePerformanceRows(performanceMatrix.slice(3));
  const positions: LedgerPositionRow[] = [];
  let rowNumberOffset = 0;
  const positionMatrices = [positionMatrix, ...additionalPositionMatrices];
  for (const [index, matrix] of positionMatrices.entries()) {
    const parsedPositions = parsePositionRows(matrix, {
      rowNumberOffset,
      sheetLabel:
        index === 0
          ? TRANSACTION_POSITION_SHEET_NAME
          : AVAILABLE_POSITION_SHEET_NAME,
      optionalHeaders:
        index === 0 ? undefined : AVAILABLE_POSITION_OPTIONAL_HEADERS,
    });
    positions.push(...parsedPositions);
    rowNumberOffset = Math.max(
      rowNumberOffset,
      ...parsedPositions.map((row) => row.rowNumber),
    );
  }
  if (!performance.length) {
    throw new BondLedgerParseError("第一张表没有可用的逐日收益数据");
  }
  if (!positions.length) {
    throw new BondLedgerParseError("持仓表没有可用的当日持仓数据");
  }
  const dates = new Set(positions.map((row) => row.reportDate));
  if (dates.size !== 1) {
    throw new BondLedgerParseError("交易户和可供户必须只包含一个报表日期");
  }
  const date = positions[0]?.reportDate ?? "";
  if (!performance.some((row) => row.date === date)) {
    throw new BondLedgerParseError("两张表的报表日期不一致");
  }
  return {
    date,
    performance: performance.filter((row) => row.date <= date),
    positions,
  };
}

function validatePerformanceHeader(matrix: Matrix): void {
  const first = matrix[0] ?? [];
  const checks: Array<[number, string]> = [
    [PERFORMANCE_COLUMNS.date, "日期"],
    [PERFORMANCE_COLUMNS.principal, "业务本金"],
    [PERFORMANCE_COLUMNS.marketValue, "持仓规模"],
    [PERFORMANCE_COLUMNS.leverage, "杠杆率"],
    [PERFORMANCE_COLUMNS.modifiedDuration, "修正久期"],
  ];
  for (const [index, expected] of checks) {
    if (!normalizeHeader(first[index]).includes(normalizeHeader(expected))) {
      throw new BondLedgerParseError(`第一张表缺少标准列“${expected}”`);
    }
  }
}

function parsePerformanceRows(rows: Matrix): LedgerPerformanceRow[] {
  const parsed: LedgerPerformanceRow[] = [];
  for (const row of rows) {
    const date = toIsoDate(row[PERFORMANCE_COLUMNS.date]);
    if (!date) continue;
    const principal = toNumber(row[PERFORMANCE_COLUMNS.principal]);
    const marketValue = toNumber(row[PERFORMANCE_COLUMNS.marketValue]);
    if (principal === null || marketValue === null) continue;
    parsed.push({
      date,
      principal,
      timeWeightedPrincipal:
        toNumber(row[PERFORMANCE_COLUMNS.timeWeightedPrincipal]) ?? principal,
      marketValue,
      leverage: toNumber(row[PERFORMANCE_COLUMNS.leverage]) ?? 0,
      modifiedDuration:
        toNumber(row[PERFORMANCE_COLUMNS.modifiedDuration]) ?? 0,
      dailyRevenue: toNumber(row[PERFORMANCE_COLUMNS.dailyRevenue]) ?? 0,
      cumulativeProfit:
        toNumber(row[PERFORMANCE_COLUMNS.cumulativeProfit]) ?? 0,
      ytdAnnualizedReturn: toNumber(
        row[PERFORMANCE_COLUMNS.ytdAnnualizedReturn],
      ),
      ytdExTaxAnnualizedReturn: toNumber(
        row[PERFORMANCE_COLUMNS.ytdExTaxAnnualizedReturn],
      ),
    });
  }
  return parsed.sort((left, right) => left.date.localeCompare(right.date));
}

function parsePositionRows(
  matrix: Matrix,
  options: {
    rowNumberOffset: number;
    sheetLabel: string;
    optionalHeaders?: ReadonlySet<string>;
  },
): LedgerPositionRow[] {
  const headers = matrix[0] ?? [];
  const columns = new Map<string, number>();
  headers.forEach((header, index) => columns.set(normalizeHeader(header), index));
  for (const expected of REQUIRED_POSITION_HEADERS) {
    if (
      !columns.has(normalizeHeader(expected)) &&
      !options.optionalHeaders?.has(expected)
    ) {
      throw new BondLedgerParseError(
        `${options.sheetLabel}缺少标准列“${expected}”`,
      );
    }
  }
  const column = (name: string) => columns.get(normalizeHeader(name));
  const value = (row: unknown[], name: string) => row[column(name) ?? -1];
  const realizedProfitColumn = column("资本利得");
  const hasPledgedQuantity = column("今日质押量") !== undefined;
  const hasAvailableQuantity = column("今日可用量") !== undefined;
  if (hasPledgedQuantity !== hasAvailableQuantity) {
    throw new BondLedgerParseError(
      `${options.sheetLabel}须同时提供“今日质押量”和“今日可用量”`,
    );
  }
  const result: LedgerPositionRow[] = [];
  for (const [index, row] of matrix.slice(1).entries()) {
    const reportDate = toIsoDate(value(row, "报表日期"));
    const code = toText(value(row, "债券代码"));
    const name = toText(value(row, "债券名称"));
    if (!reportDate || (!code && !name)) continue;
    const currentQuantity = toNumber(value(row, "今日持仓量")) ?? 0;
    const pledgedQuantity = toNumber(value(row, "今日质押量"));
    const availableQuantity = toNumber(value(row, "今日可用量"));
    if (hasPledgedQuantity) {
      const location = `${options.sheetLabel}第${index + 2}行（${code || name}）`;
      if (pledgedQuantity === null || availableQuantity === null) {
        throw new BondLedgerParseError(`${location}的今日质押量、今日可用量须填写有效数值`);
      }
      if (pledgedQuantity < 0 || availableQuantity < 0) {
        throw new BondLedgerParseError(`${location}的今日质押量、今日可用量不能为负数`);
      }
      if (Math.abs(pledgedQuantity + availableQuantity - currentQuantity) > 0.000001) {
        throw new BondLedgerParseError(`${location}的今日质押量加今日可用量须等于今日持仓量`);
      }
    }
    result.push({
      reportDate,
      rowNumber: options.rowNumberOffset + index + 1,
      team: toText(value(row, "团队")),
      investmentManager: toText(value(row, "投资经理")),
      account: toText(value(row, "账户")),
      code,
      market: toText(value(row, "交易市场")),
      name,
      category: toText(value(row, "债券分类")) || "未分类",
      yieldChangeBp: toNumber(value(row, "收益率变动(BP)")),
      remainingYears: toNumber(value(row, "剩余期限（年）")),
      interestStartDate: toIsoDate(value(row, "起息日")),
      maturityDate: toIsoDate(value(row, "到期日")),
      currentQuantity,
      pledgedQuantity,
      availableQuantity,
      previousQuantity: toNumber(value(row, "昨日持仓量")) ?? 0,
      buyQuantity: toNumber(value(row, "当日买量")) ?? 0,
      sellQuantity: toNumber(value(row, "当日卖量")) ?? 0,
      maturityQuantity: toNumber(value(row, "当日到期量")) ?? 0,
      couponRate: toNumber(value(row, "票面利率")),
      valuationYield: toNumber(value(row, "今日估值收益率")),
      reportYield: toNumber(value(row, "含免税报表收益率")),
      fullPrice: toNumber(value(row, "估值全价")),
      dv01: toNumber(value(row, "DV01")) ?? 0,
      marketValue: toNumber(value(row, "全价市值")) ?? 0,
      couponIncome: toNumber(value(row, "票息收入")) ?? 0,
      taxExemptIncome: toNumber(value(row, "免税收入")) ?? 0,
      realizedProfit:
        realizedProfitColumn === undefined
          ? null
          : toNumber(row[realizedProfitColumn]),
      dailyProfit: toNumber(value(row, "当日损益")) ?? 0,
      ytdProfit: toNumber(value(row, "全年损益")) ?? 0,
      fullPriceCost: toNumber(value(row, "全价成本")) ?? 0,
    });
  }
  return result;
}

function findWorkbookSheet(
  workbook: import("xlsx").WorkBook,
  expectedName: string,
): import("xlsx").WorkSheet | undefined {
  const sheetName = workbook.SheetNames.find(
    (name) => normalizeHeader(name) === normalizeHeader(expectedName),
  );
  return sheetName ? workbook.Sheets[sheetName] : undefined;
}

function normalizeHeader(value: unknown): string {
  return toText(value)
    .replaceAll("\n", "")
    .replaceAll(" ", "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .toUpperCase();
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replaceAll(",", "").replaceAll("%", "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
      .join("-");
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.floor(value));
    return epoch.toISOString().slice(0, 10);
  }
  const text = toText(value);
  if (!text || text === "0") return null;
  const match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]?.padStart(2, "0")}-${match[3]?.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || !parsed.toISOString().startsWith(iso)
    ? null
    : iso;
}
