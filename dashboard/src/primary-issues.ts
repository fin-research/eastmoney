import {
  isEastmoneyText,
  normalizeCompany,
  number,
  string,
  type Row,
} from "./rows.ts";

export const PRIMARY_CATEGORY_ORDER = [
  "短融",
  "公募短债",
  "小公募",
  "次级债",
  "私募债",
] as const;

export interface PrimaryIssueDetail {
  issue_date: string;
  issue_date_key: string;
  issuer: string;
  category: string;
  bond_names: string[];
  tenors: string[];
  coupons: Array<number | null>;
  amount: number | null;
}

interface PrimaryIssueLeg {
  bondName: string;
  tenor: string;
  tenorDays: number;
  coupon: number | null;
}

interface PrimaryIssueGroup {
  issueDate: string;
  issueDateKey: string;
  issuer: string;
  category: string;
  amount: number | null;
  legs: PrimaryIssueLeg[];
}

export function primaryIssueDetails(
  rows: Row[],
  reportDate: string,
): PrimaryIssueDetail[] {
  const groups = new Map<string, PrimaryIssueGroup>();
  const candidates = rows.flatMap((row) => {
    if (isEastmoneyIssue(row)) return [];
    const issueDate = primaryDate(row);
    const issueDateKey = primaryDateKey(row, issueDate, reportDate);
    return issueDateKey ? [{ row, issueDate, issueDateKey }] : [];
  });
  const previousDate = candidates
    .map((item) => item.issueDateKey)
    .filter((value) => value < reportDate)
    .sort()
    .at(-1);
  const allowedDates = new Set(
    [reportDate, previousDate].filter((value): value is string => !!value),
  );

  for (const { row, issueDate, issueDateKey } of candidates) {
    if (!allowedDates.has(issueDateKey)) continue;
    const issuer = primaryIssuer(row);
    const amount = number(row.amount) ?? number(row.planIssueAmount);
    if (!issuer) continue;

    const category = primaryCategory(row);
    const groupKey = `${issueDateKey}\u0000${category}\u0000${issuer}`;
    const group = groups.get(groupKey) ?? {
      issueDate,
      issueDateKey,
      issuer,
      category,
      amount: 0,
      legs: [],
    };
    group.amount = group.amount === null || amount === null ? null : group.amount + amount;
    group.legs.push({
      bondName: string(row.bond_name || row.bondShortName) || "--",
      tenor: primaryTenor(row),
      tenorDays: primaryTenorDays(row.issueTenor, row.tenor_years),
      coupon: number(row.coupon) ?? number(row.issueCouponRate),
    });
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .sort(
      (left, right) =>
        right.issueDateKey.localeCompare(left.issueDateKey) ||
        categoryIndex(left.category) - categoryIndex(right.category) ||
        left.issuer.localeCompare(right.issuer, "zh-CN"),
    )
    .map((group) => {
      const legs = group.legs.sort(
        (left, right) =>
          left.tenorDays - right.tenorDays ||
          left.bondName.localeCompare(right.bondName, "zh-CN"),
      );
      const uniqueLegs = legs.filter(
        (leg, index) =>
          index === 0 ||
          leg.tenor !== legs[index - 1]!.tenor ||
          leg.coupon !== legs[index - 1]!.coupon,
      );
      return {
        issue_date: group.issueDate,
        issue_date_key: group.issueDateKey,
        issuer: group.issuer,
        category: group.category,
        bond_names: legs.map((leg) => leg.bondName),
        tenors: uniqueLegs.map((leg) => leg.tenor),
        coupons: uniqueLegs.map((leg) => leg.coupon),
        amount: group.amount,
      };
    });
}

export function formatPrimaryAmount(value: number | null): string {
  if (value === null) return "规模暂缺";
  return `${Math.round(value).toLocaleString("zh-CN")}亿`;
}

export function formatPrimaryCoupons(values: Array<number | null>): string {
  return values
    .map((value) => (value === null ? "-" : `${value.toFixed(2)}%`))
    .join("/");
}

function primaryCategory(row: Row): string {
  const enriched = string(row.category);
  if (enriched) return enriched === "公募次级债" ? "次级债" : enriched;
  if (
    string(row.publicOffering) === "2" ||
    [
      row.publicOfferingText,
      row.offeringType,
      row.issueWay,
      row.raisingMode,
    ].some((value) => value != null && string(value).includes("私募"))
  ) {
    return "私募债";
  }
  const bondType = string(row.bondTypeText);
  if (bondType.includes("短期融资券")) return "短融";
  if (bondType.includes("次级债")) return "次级债";
  if (
    primaryTenorDays(row.issueTenor, row.tenor_years) <= 365 ||
    /S\d+$/.test(string(row.bondShortName))
  ) {
    return "公募短债";
  }
  return "小公募";
}

function primaryIssuer(row: Row): string {
  const enriched = string(row.issuer);
  if (enriched) return enriched;
  for (const key of ["comShortName", "issuerShortName", "issuerShortNameCn"]) {
    const value = normalizePrimary(normalizeCompany(row[key]));
    if (value) return value;
  }
  return normalizePrimary(row.comFullName || row.issuerName);
}

function normalizePrimary(value: unknown): string {
  let text = string(value).replace(/\s+/g, "");
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

function primaryDate(row: Row): string {
  const enriched = string(row.issue_date);
  if (/^\d{2}\/\d{2}$/.test(enriched)) return enriched;
  const raw = string(row.bidStartDate || row.issueStartDate);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return `${raw.slice(5, 7)}/${raw.slice(8, 10)}`;
  }
  const bidding = string(row.biddingTime);
  return /^\d{2}-\d{2}/.test(bidding)
    ? bidding.slice(0, 5).replace("-", "/")
    : "--/--";
}

function primaryDateKey(
  row: Row,
  label: string,
  reportDate: string,
): string {
  const raw = string(row.bidStartDate || row.issueStartDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (!/^\d{2}\/\d{2}$/.test(label)) return "";
  const reportYear = Number(reportDate.slice(0, 4));
  const reportMonthDay = reportDate.slice(5).replace("-", "/");
  const year = label > reportMonthDay ? reportYear - 1 : reportYear;
  return `${year}-${label.replace("/", "-")}`;
}

function primaryTenor(row: Row): string {
  const raw = string(row.issueTenor).trim().toUpperCase();
  const dayMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)D$/);
  if (dayMatch) return `${Math.round(Number(dayMatch[1]))}天`;
  const yearMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)Y$/);
  if (yearMatch) {
    const years = Number(yearMatch[1]);
    return years < 1
      ? `${Math.trunc(years * 365)}天`
      : `${compactNumber(years)}年`;
  }
  const perpetualMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\+N$/);
  if (perpetualMatch) return `${compactNumber(Number(perpetualMatch[1]))}+N年`;

  const years = number(row.tenor_years);
  if (years === null) return raw || "-";
  return years < 1
    ? `${Math.round(years * 365)}天`
    : `${compactNumber(years)}年`;
}

function primaryTenorDays(rawValue: unknown, enrichedValue: unknown): number {
  const raw = string(rawValue).trim().toUpperCase();
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)([YD])/);
  if (match) {
    const value = Number(match[1]);
    return match[2] === "D" ? value : value * 365;
  }
  const perpetual = raw.match(/^([0-9]+(?:\.[0-9]+)?)\+N$/);
  if (perpetual) return Number(perpetual[1]) * 365;
  const years = number(enrichedValue);
  return years === null ? Number.POSITIVE_INFINITY : years * 365;
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "");
}

function categoryIndex(category: string): number {
  const index = PRIMARY_CATEGORY_ORDER.indexOf(
    category as (typeof PRIMARY_CATEGORY_ORDER)[number],
  );
  return index < 0 ? PRIMARY_CATEGORY_ORDER.length : index;
}

function isEastmoneyIssue(row: Row): boolean {
  return [
    row.bondShortName,
    row.bond_name,
    row.issuer,
    row.comShortName,
    row.issuerShortName,
    row.issuerShortNameCn,
  ].some(isEastmoneyText);
}
