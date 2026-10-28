import type {
  BondInfo,
  CfetsRate,
  FavoriteQuote,
  FuturesQuote,
  GovernmentBond,
  IndustrySnapshot,
  MarginBalance,
  OmoOperation,
  PrimaryIssue,
  StockSummary,
  TodayTrade,
} from "./data-contracts.ts";
import type { ReportData } from "./types";

const FUNDING_CODES = ["DR001", "DR007", "DIBO001", "DIBO007"] as const;
const GOVERNMENT_BOND_TARGETS = [
  ["国债", "1Y"],
  ["国债", "5Y"],
  ["国债", "10Y"],
  ["国债", "超长期限"],
  ["国开", "10Y"],
] as const;
const FUTURES_CODES = ["TL9999", "T9999", "TF9999", "TS9999"] as const;
const PRIMARY_ISSUE_ORDER = ["短融", "公募短债", "小公募", "次级债", "私募债"] as const;

export interface RawMarketReportResources {
  reportDate: string;
  generatedAt: string;
  previousPrimaryDate: string;
  omo: OmoOperation[];
  dr: CfetsRate[];
  dibo: CfetsRate[];
  governmentBonds: GovernmentBond[];
  futures: FuturesQuote[];
  stock: StockSummary;
  margin: MarginBalance[];
  industry: IndustrySnapshot;
  primary: PrimaryIssue[];
  todayTrades: TodayTrade[];
  favoriteQuotes: FavoriteQuote[];
  bondInfos: BondInfo[];
}

export function dayOffset(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function toFloat(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\d.\-]/g, "");
  if (!cleaned || ["-", ".", "-."].includes(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: unknown): string | null {
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function normalizeCompanyShortName(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, "");
  return text === "安信证券" ? "国投证券" : text;
}

function normalizePrimaryIssuerName(value: unknown): string {
  let text = String(value ?? "").replace(/\s+/g, "");
  if (!text) return "";
  if (text === "中国国际金融股份有限公司") return "中金公司";
  if (text === "中国中金财富证券有限公司") return "中金财富";
  for (const suffix of ["股份有限公司", "有限责任公司", "有限公司"]) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
      break;
    }
  }
  if (text.startsWith("中国中金")) text = text.slice(2);
  return [...text].slice(0, 4).join("");
}

function primaryIssuer(row: PrimaryIssue): string {
  for (const key of ["comShortName", "issuerShortName", "issuerShortNameCn"] as const) {
    const value = normalizePrimaryIssuerName(normalizeCompanyShortName(row[key]));
    if (value) return value;
  }
  return normalizePrimaryIssuerName(row.comFullName ?? row.issuerName);
}

function isPrivatePrimary(row: PrimaryIssue): boolean {
  return (
    String(row.publicOffering) === "2" ||
    [row.publicOfferingText, row.offeringType, row.issueWay, row.raisingMode].some(
      (value) => value != null && String(value).includes("私募"),
    )
  );
}

function primaryTenorLeOneYear(value: unknown): boolean {
  const match = /^([0-9]+(?:\.[0-9]+)?)([YD]).*/.exec(
    String(value ?? "").trim().toUpperCase(),
  );
  if (!match?.[1] || !match[2]) return false;
  const number = Number(match[1]);
  return match[2] === "Y" ? number <= 1 : number <= 365;
}

function classifyPrimary(row: PrimaryIssue): string {
  const bondType = String(row.bondTypeText ?? "");
  const bondName = String(row.bondShortName ?? "");
  if (isPrivatePrimary(row)) return "私募债";
  if (bondType.includes("短期融资券")) return "短融";
  if (bondType.includes("次级债")) return "次级债";
  if (primaryTenorLeOneYear(row.issueTenor) || /S\d+$/.test(bondName)) {
    return "公募短债";
  }
  return "小公募";
}

function primaryDateKey(row: PrimaryIssue): string {
  return isoDate(row.bidStartDate) ?? isoDate(row.issueStartDate) ?? "";
}

function primaryDateText(row: PrimaryIssue): string {
  const date = primaryDateKey(row);
  if (date) return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
  const bidding = String(row.biddingTime ?? "");
  return /^\d{2}-\d{2}/.test(bidding)
    ? bidding.slice(0, 5).replace("-", "/")
    : "--/--";
}

function isEastmoney(value: unknown): boolean {
  const text = String(value ?? "");
  return text.includes("东财") || text.includes("东方财富");
}

function isEastmoneyPrimary(row: PrimaryIssue): boolean {
  return [
    row.bondShortName,
    row.comShortName,
    row.issuerShortName,
    row.issuerShortNameCn,
  ].some((value) => value != null && isEastmoney(value));
}

function formatPrimaryTenor(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  let match = /^([0-9]+(?:\.[0-9]+)?)D$/.exec(text);
  if (match?.[1]) return `${Number(match[1])}天`;
  match = /^([0-9]+(?:\.[0-9]+)?)Y$/.exec(text);
  if (match?.[1]) {
    const years = Number(match[1]);
    return years < 1 ? `${Math.trunc(years * 365)}天` : `${years}年`;
  }
  match = /^([0-9]+(?:\.[0-9]+)?)\+N$/.exec(text);
  return match?.[1] ? `${Number(match[1])}+N年` : text || "-";
}

function primaryTenorDays(value: unknown): number {
  const text = String(value ?? "").trim().toUpperCase();
  const match = /^([0-9]+(?:\.[0-9]+)?)([YD])/.exec(text);
  if (match?.[1] && match[2]) {
    const number = Number(match[1]);
    return match[2] === "D" ? number : number * 365;
  }
  const perpetual = /^([0-9]+(?:\.[0-9]+)?)\+N$/.exec(text);
  return perpetual?.[1]
    ? Number(perpetual[1]) * 365
    : Number.POSITIVE_INFINITY;
}

function parseTenorYears(value: unknown): number | null {
  const text = String(value ?? "").trim().toUpperCase();
  const match = /^([\d.]+)\s*([YD])/.exec(text);
  if (match?.[1] && match[2]) {
    const number = Number(match[1]);
    return match[2] === "Y" ? number : number / 365;
  }
  const perpetual = /^([\d.]+)\s*\+\s*N$/.exec(text);
  return perpetual?.[1] ? Number(perpetual[1]) : null;
}

function aggregatePrimaryIssues(primaryRows: PrimaryIssue[]): ReportData["primary_issues"] {
  interface Leg {
    bondName: string;
    tenor: string;
    tenorDays: number;
    coupon: number | null;
  }
  interface Group {
    issueDate: string;
    issueDateKey: string;
    issuer: string;
    category: string;
    amount: number | null;
    legs: Leg[];
  }
  const groups = new Map<string, Group>();
  for (const row of primaryRows) {
    if (isEastmoneyPrimary(row)) continue;
    const issueDateKey = primaryDateKey(row);
    const issuer = primaryIssuer(row) || "发行人暂缺";
    const amount = toFloat(row.planIssueAmount);
    if (!issueDateKey) continue;
    const category = classifyPrimary(row);
    const key = `${issueDateKey}\u0000${category}\u0000${issuer}${issuer === "发行人暂缺" ? `\u0000${groups.size}` : ""}`;
    const group = groups.get(key) ?? {
      issueDate: primaryDateText(row),
      issueDateKey,
      issuer,
      category,
      amount: 0,
      legs: [],
    };
    group.amount = group.amount === null || amount === null ? null : group.amount + amount;
    group.legs.push({
      bondName: String(row.bondShortName ?? "--"),
      tenor: formatPrimaryTenor(row.issueTenor),
      tenorDays: primaryTenorDays(row.issueTenor),
      coupon: toFloat(row.issueCouponRate),
    });
    groups.set(key, group);
  }
  const order = new Map(
    PRIMARY_ISSUE_ORDER.map((category, index) => [category, index]),
  );
  return [...groups.values()]
    .map((group) => {
      group.legs.sort(
        (left, right) =>
          left.tenorDays - right.tenorDays ||
          left.bondName.localeCompare(right.bondName),
      );
      const unique: Leg[] = [];
      for (const leg of group.legs) {
        const previous = unique.at(-1);
        if (
          !previous ||
          previous.tenor !== leg.tenor ||
          previous.coupon !== leg.coupon
        ) {
          unique.push(leg);
        }
      }
      return {
        issue_date: group.issueDate,
        issue_date_key: group.issueDateKey,
        issuer: group.issuer,
        category: group.category,
        amount: group.amount,
        bond_names: group.legs.map((leg) => leg.bondName),
        tenors: unique.map((leg) => leg.tenor),
        coupons: unique.map((leg) => leg.coupon),
      };
    })
    .sort(
      (left, right) =>
        right.issue_date_key.localeCompare(left.issue_date_key) ||
        (order.get(left.category as (typeof PRIMARY_ISSUE_ORDER)[number]) ??
          order.size) -
          (order.get(right.category as (typeof PRIMARY_ISSUE_ORDER)[number]) ??
            order.size) ||
        left.issuer.localeCompare(right.issuer),
    );
}

function primaryReport(
  primaryRows: PrimaryIssue[],
  reportDate: string,
  previousDate: string,
): Pick<ReportData, "primary_summary" | "primary_issues"> {
  const datedRows = primaryRows.filter((row) =>
    [previousDate, reportDate].includes(primaryDateKey(row)),
  );
  const amount = (date: string): number | null => {
    if (!date) return null;
    // Undated rows could belong to this date; do not publish a partial total.
    if (primaryRows.some((row) => !isEastmoneyPrimary(row) && !primaryDateKey(row))) return null;
    const candidates = datedRows.filter((row) => primaryDateKey(row) === date && !isEastmoneyPrimary(row));
    let total = 0;
    for (const row of candidates) {
      const value = toFloat(row.planIssueAmount);
      // Issuance volume does not depend on parsing the bond's tenor.
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  const current = amount(reportDate);
  const previous = amount(previousDate);
  return {
    primary_summary: {
      current_amount: current,
      change_amount: current === null || previous === null ? null : current - previous,
    },
    primary_issues: aggregatePrimaryIssues(datedRows),
  };
}

function positiveYield(value: unknown): number | null {
  const parsed = toFloat(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function quoteYields(row: FavoriteQuote): readonly [number | null, number | null] {
  return [
    positiveYield(row.bidYield) ?? positiveYield(row.bidEntryPrice),
    positiveYield(row.ofrYield) ?? positiveYield(row.ofrEntryPrice),
  ];
}

type EnrichedTodayTrade = TodayTrade & Partial<BondInfo>;
type EnrichedFavoriteQuote = FavoriteQuote & Partial<BondInfo>;

function normalizeSecondary(rows: EnrichedTodayTrade[]): ReportData["secondary_bonds"] {
  const result: ReportData["secondary_bonds"] = [];
  for (const row of rows) {
    const bondName = String(row.bondShortName ?? "").trim().split(" ")[0] ?? "";
    const issuer = normalizeCompanyShortName(row.comShortName);
    const tenorLabel = String(row.remainingTenor ?? "");
    const tenorYears = parseTenorYears(tenorLabel);
    const tradeYield = toFloat(row.tradeYield);
    if (
      row.bondType !== 37 ||
      row.bondOfferingType !== 1 ||
      row.sciTechInnoBondStatus !== 0 ||
      isEastmoney(bondName) ||
      isEastmoney(issuer) ||
      tenorYears === null ||
      tenorYears > 5 ||
      tradeYield === null
    ) {
      continue;
    }
    result.push({
      bond_id: String(row.bondUniCode ?? bondName),
      bond_name: bondName,
      issuer: issuer || [...bondName].slice(2, 4).join("") || "未知",
      tenor_label: tenorLabel,
      tenor_years: tenorYears,
      valuation: toFloat(row.cbYte),
      trade_yield: tradeYield,
    });
  }
  return result;
}

function normalizeInventory(
  inventory: EnrichedFavoriteQuote[],
  trades: EnrichedTodayTrade[],
): ReportData["inventory_bonds"] {
  const tradeYieldByCode = new Map(
    trades
      .filter((row) => row.bondUniCode != null)
      .map((row) => [String(row.bondUniCode), toFloat(row.tradeYield)]),
  );
  const result: ReportData["inventory_bonds"] = [];
  for (const row of inventory) {
    const tenorDays = toFloat(row.remainingTenorDay);
    const tenorYears =
      tenorDays === null
        ? parseTenorYears(row.remainingTenor)
        : tenorDays / 365;
    const valuation = toFloat(row.cbYield);
    if (tenorYears === null || valuation === null) continue;
    const [bidYield, ofrYield] = quoteYields(row);
    // Entry prices can contain a net price (e.g. 100) instead of a yield.
    // Reject nonpositive values and deviations over 500 bp for inventory bonds.
    const validTradeYield = (value: unknown): number | null => {
      const parsed = positiveYield(value);
      return parsed !== null && Math.abs(parsed - valuation) <= 5 ? parsed : null;
    };
    const quoteTradeYield = validTradeYield(row.tradeEntryPrice);
    const tradeYield = quoteTradeYield ?? validTradeYield(
      tradeYieldByCode.get(String(row.bondUniCode)),
    );
    result.push({
      bond_name: String(row.bondShortName ?? "--").trim(),
      tenor_label: String(row.remainingTenor ?? ""),
      tenor_years: tenorYears,
      valuation,
      trade_yield: tradeYield,
      trade_spread_bp: tradeYield === null
        ? null
        : quoteTradeYield !== null
          ? toFloat(row.tradeYieldSubCb)
          : Math.round((tradeYield - valuation) * 100 * 1e6) / 1e6,
      bid_yield: bidYield,
      ofr_yield: ofrYield,
    });
  }
  return result.sort((left, right) => left.tenor_years - right.tenor_years);
}

function fundingRates(dr: CfetsRate[], dibo: CfetsRate[]): ReportData["funding_rates"] {
  const byCode = new Map(
    [...dr, ...dibo].map((row) => [
      row.bondCode,
      row,
    ]),
  );
  return FUNDING_CODES.flatMap((code) => {
    const row = byCode.get(code);
    return row
      ? [
          {
            code,
            rate: toFloat(row.weightedYield),
            change_bp: toFloat(row.weightedYieldUpDownValueBp),
          },
        ]
      : [];
  });
}

function governmentBonds(rows: GovernmentBond[]): ReportData["government_bonds"] {
  return GOVERNMENT_BOND_TARGETS.flatMap(([category, tenor]) => {
    const row = rows
      .filter(
        (candidate) =>
          candidate.ordinateName === category && candidate.abscissaName === tenor,
      )
      .sort(
        (left, right) =>
          (toFloat(right.tradeNum) ?? 0) - (toFloat(left.tradeNum) ?? 0),
      )[0];
    return row
      ? [
          {
            category,
            tenor,
            code: String(row.bondCode ?? "--"),
            yield_rate: toFloat(row.yield),
            change_bp: toFloat(row.yieldSubYtdCloseBp),
          },
        ]
      : [];
  });
}

function futures(rows: FuturesQuote[]): ReportData["futures"] {
  const byCode = new Map(rows.map((row) => [row.contractCode, row]));
  return FUTURES_CODES.flatMap((code) => {
    const row = byCode.get(code);
    return row
      ? [
          {
            code,
            last_price: toFloat(row.lastPrice),
            change_pct: toFloat(row.upDownValuePct),
          },
        ]
      : [];
  });
}

function margin(rows: MarginBalance[]): ReportData["margin"] {
  const current = rows[0];
  const previous = rows[1];
  const yi = (value: unknown) => {
    const parsed = toFloat(value);
    return parsed === null ? null : parsed / 1e8;
  };
  const change = (left: number | null, right: number | null) =>
    left === null || right === null ? null : left - right;
  const total = yi(current?.TOTAL_RZRQYE);
  const previousTotal = yi(previous?.TOTAL_RZRQYE);
  const financing = yi(current?.TOTAL_RZYE);
  const previousFinancing = yi(previous?.TOTAL_RZYE);
  const lending = yi(current?.TOTAL_RQYE);
  const previousLending = yi(previous?.TOTAL_RQYE);
  return {
    data_date: isoDate(current?.DIM_DATE),
    total,
    total_change: change(total, previousTotal),
    financing,
    financing_change: change(financing, previousFinancing),
    securities_lending: lending,
    securities_lending_change: change(lending, previousLending),
  };
}

function omoOperations(rows: OmoOperation[]): ReportData["omo_operations"] {
  const dates = [
    ...new Set(
      rows
        .map((row) => isoDate(row.operationDate))
        .filter((value): value is string => value !== null),
    ),
  ]
    .sort()
    .slice(-10);
  const allowed = new Set(dates);
  return rows.flatMap((row) => {
    const operationDate = isoDate(row.operationDate);
    return operationDate && allowed.has(operationDate)
      ? [
          {
            operation_date: operationDate,
            operation_name: String(row.operationName ?? ""),
            duration: String(row.duration ?? ""),
            amount_yi: toFloat(row.operationAmount),
            interest_rate: toFloat(row.interestRate),
          },
        ]
      : [];
  });
}

function attachBondInfos<T extends TodayTrade | FavoriteQuote>(
  rows: T[],
  infos: BondInfo[],
  infoFirst: boolean,
): Array<T & Partial<BondInfo>> {
  const byCode = new Map(infos.map((row) => [String(row.bondUniCode), row]));
  return rows.map((row) => {
    const info = byCode.get(String(row.bondUniCode));
    if (!info) return row;
    const merged = { ...row, ...info };
    if (infoFirst) {
      // A missing quote name must not overwrite the known basic-info name.
      for (const [key, value] of Object.entries(row)) {
        if (value != null && value !== "") Reflect.set(merged, key, value);
      }
    }
    return merged;
  });
}

export function referencedBondCodes(
  todayTrades: TodayTrade[],
  favoriteQuotes: FavoriteQuote[],
): string[] {
  return [
    ...new Set(
      [
        ...todayTrades,
        ...favoriteQuotes,
      ]
        .map((row) => String(row.bondUniCode ?? ""))
        .filter((code) => code && code !== "0"),
    ),
  ];
}

export function buildOpenMarketModule(rows: OmoOperation[]): Pick<ReportData, "omo_operations"> {
  return { omo_operations: omoOperations(rows) };
}

export function buildFixedIncomeModule(
  resources: Pick<RawMarketReportResources, "dr" | "dibo" | "governmentBonds" | "futures">,
): Pick<ReportData, "funding_rates" | "government_bonds" | "futures"> {
  return {
    funding_rates: fundingRates(resources.dr, resources.dibo),
    government_bonds: governmentBonds(resources.governmentBonds),
    futures: futures(resources.futures),
  };
}

export function buildEquityModule(
  resources: Pick<RawMarketReportResources, "stock" | "margin" | "industry">,
): Pick<ReportData, "stock_paragraphs" | "margin" | "equities" | "equity_data_time" |
  "turnover_yi" | "turnover_change_yi" | "industries" | "industry_data_date"> {
  const { stock, industry } = resources;
  return {
    stock_paragraphs: stock.paragraphs.slice(0, 2),
    margin: margin(resources.margin),
    equities: industry.equities,
    equity_data_time: null,
    turnover_yi: toFloat(industry.turnoverYi),
    turnover_change_yi: toFloat(industry.turnoverChangeYi),
    industries: industry.industries,
    industry_data_date: industry.dataDate,
  };
}

export function buildPrimaryModule(rows: PrimaryIssue[], reportDate: string, previousDate: string) {
  return primaryReport(rows, reportDate, previousDate);
}

export function buildSecondaryModule(trades: TodayTrade[], infos: BondInfo[]): Pick<ReportData, "secondary_bonds"> {
  return { secondary_bonds: normalizeSecondary(attachBondInfos(trades, infos, false)) };
}

export function buildInventoryModule(
  quotes: FavoriteQuote[], trades: TodayTrade[], infos: BondInfo[],
): Pick<ReportData, "inventory_bonds"> {
  return { inventory_bonds: normalizeInventory(attachBondInfos(quotes, infos, true), trades) };
}

/** Legacy callers use the same module transformations as the Workflow. */
export function buildReportData(resources: RawMarketReportResources): ReportData {
  return {
    report_date: resources.reportDate,
    generated_at: resources.generatedAt,
    ...buildOpenMarketModule(resources.omo),
    ...buildFixedIncomeModule(resources),
    ...buildEquityModule(resources),
    ...buildPrimaryModule(resources.primary, resources.reportDate, resources.previousPrimaryDate),
    ...buildSecondaryModule(resources.todayTrades, resources.bondInfos),
    ...buildInventoryModule(resources.favoriteQuotes, resources.todayTrades, resources.bondInfos),
  };
}
