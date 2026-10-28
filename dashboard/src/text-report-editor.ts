import {
  bondText,
  briefOmo,
  buildTextReport,
  emBondLine,
  fundText,
  futureContractText,
  marginTrading,
  normalizeTextReport,
  secondaryBondLine,
} from "./text-report.ts";
import { formatPrimaryCoupons } from "./primary-issues.ts";
import type {
  BondFuture,
  FundingRate,
  GovernmentBond,
  InventoryPoint,
  MarketReportResource,
  OmoOperation,
  PrimaryIssueDetail,
  ReportData,
  SecondaryBond,
} from "./types.ts";

export interface TextReportEditResult {
  data: ReportData;
  focusText: string;
  issues: string[];
}

const REQUIRED_SECTIONS = [
  "央行",
  "利率",
  "股市",
  "一级发行",
  "二级行情",
  "今日聚焦",
] as const;

const GOVERNMENT_LABELS = [
  ["30年期国债", "国债", "超长期限"],
  ["10年期国债", "国债", "10Y"],
  ["5年期国债", "国债", "5Y"],
  ["1年期国债", "国债", "1Y"],
  ["10年期国开债", "国开", "10Y"],
] as const;

const FUTURE_LABELS = [
  ["TL9999", "30年期主力合约"],
  ["T9999", "10年期主力合约"],
  ["TF9999", "5年期主力合约"],
  ["TS9999", "2年期主力合约"],
] as const;

export function applyTextReportEdits(
  data: ReportData,
  focusText: string,
  editedText: string,
  missingResources: readonly MarketReportResource[] = [],
): TextReportEditResult {
  const sections = reportSections(editedText);
  const originalSections = reportSections(
    buildTextReport(data, focusText, missingResources),
  );
  const issues = REQUIRED_SECTIONS
    .filter((name) => !sections.has(name))
    .map((name) => `缺少【${name}】段落`);
  if (issues.length) return { data, focusText, issues };

  const next = cloneReport(data);
  updateOmo(next, sections, originalSections, issues);
  updateRates(next, sections, originalSections, issues);
  updateStocks(next, sections, originalSections, issues);
  updatePrimary(next, sections, originalSections, issues);
  updateSecondary(next, sections, originalSections, issues);

  const linkedFocus = sectionText(sections, "今日聚焦");
  if (!issues.length) {
    const regeneratedSections = reportSections(
      buildTextReport(next, linkedFocus, missingResources),
    );
    for (const name of REQUIRED_SECTIONS) {
      if (name === "今日聚焦") continue;
      const editedSection = sectionText(sections, name);
      const originalSection = sectionText(originalSections, name);
      const regeneratedSection = sectionText(regeneratedSections, name);
      if (
        editedSection !== originalSection
        && normalizeProtectedDerivedText(
          name,
          editedSection,
          originalSection,
          regeneratedSection,
        ) !== regeneratedSection
      ) {
        issues.push(`【${name}】包含无法回写为数据的修改`);
      }
    }
  }
  if (!issues.length) {
    const expectedTitle = `${data.report_date.replaceAll("-", "")} 境内市场点评`;
    const editedTitle = normalizeTextReport(editedText).split("\n")[0];
    if (editedTitle !== expectedTitle) {
      issues.push("报告标题由报告日期生成，不能在文字版中修改");
    }
  }
  return issues.length
    ? { data, focusText, issues }
    : { data: next, focusText: linkedFocus, issues };
}

function updateOmo(
  data: ReportData,
  sections: Map<string, string[]>,
  original: Map<string, string[]>,
  issues: string[],
): void {
  const text = sectionText(sections, "央行");
  if (text === sectionText(original, "央行")) return;
  const marker = text.indexOf("；今日");
  const netMarker = text.lastIndexOf("；净");
  if (marker < 0 || netMarker < marker) {
    issues.push("【央行】格式无法识别，修改未应用");
    return;
  }
  const currentRows = data.omo_operations.filter(
    (row) => row.operation_date === data.report_date,
  );
  const injectText = text.slice(0, marker);
  const drainText = text.slice(marker, netMarker);
  const inject = injectText.includes("今日未开展逆回购操作")
    ? []
    : parseOmoRows(injectText, 1, data.report_date, currentRows);
  const drain = drainText.includes("无逆回购到期")
    ? []
    : parseOmoRows(drainText, -1, data.report_date, currentRows);
  if (
    (!inject.length && !injectText.includes("今日未开展逆回购操作"))
    || (!drain.length && !drainText.includes("无逆回购到期"))
  ) {
    issues.push("【央行】操作期限、名称或金额无法识别，修改未应用");
    return;
  }
  const nextRows = [...inject, ...drain];
  if (
    normalizeTextReport(briefOmo(currentRows, data.report_date))
      === normalizeTextReport(briefOmo(nextRows, data.report_date))
  ) {
    issues.push("【央行】未识别到可回写的数据修改");
    return;
  }
  data.omo_operations = [
    ...data.omo_operations.filter(
      (row) => row.operation_date !== data.report_date,
    ),
    ...nextRows,
  ];
}

function parseOmoRows(
  text: string,
  direction: 1 | -1,
  reportDate: string,
  currentRows: OmoOperation[],
): OmoOperation[] {
  const rows: OmoOperation[] = [];
  const pattern = /(\d+(?:\.\d+)?(?:天|月|年))期(.+?)(\d+(?:\.\d+)?)亿元(?:，操作利率为(\d+(?:\.\d+)?)%)?/g;
  for (const match of text.matchAll(pattern)) {
    const duration = normalizeDuration(match[1]!);
    const operationName = match[2]!
      .replace(/^(?:中国央行今日开展|，并开展|、|；今日有)/, "")
      .trim();
    const existing = currentRows.find(
      (row) =>
        row.duration === duration
        && row.operation_name === operationName
        && Math.sign(row.amount_yi ?? 0) === direction,
    );
    rows.push({
      operation_date: reportDate,
      duration,
      operation_name: operationName,
      amount_yi: direction * Number(match[3]),
      interest_rate:
        match[4] === undefined
          ? existing?.interest_rate ?? null
          : Number(match[4]),
    });
  }
  return rows;
}

function updateRates(
  data: ReportData,
  sections: Map<string, string[]>,
  original: Map<string, string[]>,
  issues: string[],
): void {
  const text = sectionText(sections, "利率");
  if (text === sectionText(original, "利率")) return;
  const before = JSON.stringify([
    data.funding_rates,
    data.government_bonds,
    data.futures,
  ]);

  for (const code of ["DR001", "DR007", "DIBO001", "DIBO007"]) {
    const existing = data.funding_rates.find((row) => row.code === code);
    if (existing && text.includes(fundText(existing))) continue;
    const match = text.match(
      new RegExp(`${code}报(--|-?\\d+(?:\\.\\d+)?)%，(与前日持平|[涨跌]\\d+(?:\\.\\d+)?bp)`),
    );
    if (!match) continue;
    upsertFunding(data.funding_rates, {
      code,
      rate: parseNullableNumber(match[1]!),
      change_bp: parseDirection(match[2]!, "涨", "跌"),
    });
  }

  for (const [label, category, tenor] of GOVERNMENT_LABELS) {
    const existing = data.government_bonds.find(
      (row) => row.category === category && row.tenor === tenor,
    );
    if (existing && text.includes(bondText(label, existing))) continue;
    const match = text.match(
      new RegExp(`${label}([^收益，。]*)收益率(持平|[上下]行\\d+(?:\\.\\d+)?bp)报(--|-?\\d+(?:\\.\\d+)?)%`),
    );
    if (!match) continue;
    upsertGovernment(data.government_bonds, {
      category,
      tenor,
      code: match[1]!.trim() || "--",
      yield_rate: parseNullableNumber(match[3]!),
      change_bp: parseDirection(match[2]!, "上行", "下行"),
    });
  }

  for (const [code, label] of FUTURE_LABELS) {
    const existing = data.futures.find((row) => row.code === code);
    if (
      existing
      && text.includes(futureContractText(existing, label, code === "TL9999"))
    ) continue;
    const match = text.match(
      new RegExp(`${label}(持平|[涨跌]\\d+(?:\\.\\d+)?%)(?:报(--|-?\\d+(?:\\.\\d+)?))?`),
    );
    if (!match) continue;
    upsertFuture(data.futures, {
      code,
      last_price:
        match[2] === undefined
          ? existing?.last_price ?? null
          : parseNullableNumber(match[2]),
      change_pct: parseDirection(match[1]!, "涨", "跌"),
    });
  }

  if (before === JSON.stringify([
    data.funding_rates,
    data.government_bonds,
    data.futures,
  ])) {
    issues.push("【利率】未识别到可回写的数据修改");
  }
}

function updateStocks(
  data: ReportData,
  sections: Map<string, string[]>,
  original: Map<string, string[]>,
  issues: string[],
): void {
  const text = sectionText(sections, "股市");
  if (text === sectionText(original, "股市")) return;
  const before = JSON.stringify([data.stock_paragraphs, data.margin]);
  const lines = sections.get("股市") ?? [];
  const marginIndex = lines.findIndex((line) =>
    line.includes("沪深京三市融资融券余额合计")
  );
  const stockLines = lines
    .slice(0, marginIndex < 0 ? lines.length : marginIndex)
    .map((line) => line.trim())
    .filter(Boolean);
  if (stockLines.length) data.stock_paragraphs = stockLines.slice(0, 2);

  if (marginIndex < 0) {
    if (!lines.some((line) =>
      ["融资融券数据暂缺。", "融资融券数据缺失。"].includes(line.trim())
    )) {
      issues.push("【股市】融资融券行格式无法识别");
    }
    return;
  }
  if (lines[marginIndex] !== marginTrading(data.margin)) {
    const margin = parseMargin(lines[marginIndex]!, data.report_date);
    if (margin) data.margin = margin;
    else issues.push("【股市】融资融券数据格式无法识别");
  }
  if (
    !issues.some((issue) => issue.startsWith("【股市】"))
    && before === JSON.stringify([data.stock_paragraphs, data.margin])
  ) {
    issues.push("【股市】未识别到可回写的数据修改");
  }
}

function parseMargin(
  text: string,
  reportDate: string,
): ReportData["margin"] | null {
  const match = text.match(
    /^截至(\d{1,2})月(\d{1,2})日，沪深京三市融资融券余额合计(-?\d+(?:\.\d+)?)亿元，较前一交易日([^；]+)；融资余额合计(--|-?\d+(?:\.\d+)?)亿元，较前一交易日([^；]+)；融券余额合计(--|-?\d+(?:\.\d+)?)亿元，较前一交易日([^。]+)。$/,
  );
  if (!match) return null;
  const month = Number(match[1]);
  const reportMonth = Number(reportDate.slice(5, 7));
  const reportYear = Number(reportDate.slice(0, 4));
  const year = month > reportMonth ? reportYear - 1 : reportYear;
  return {
    data_date: `${year}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`,
    total: Number(match[3]),
    total_change: parseAmountChange(match[4]!),
    financing: parseNullableNumber(match[5]!),
    financing_change: parseAmountChange(match[6]!),
    securities_lending: parseNullableNumber(match[7]!),
    securities_lending_change: parseAmountChange(match[8]!),
  };
}

function updatePrimary(
  data: ReportData,
  sections: Map<string, string[]>,
  original: Map<string, string[]>,
  issues: string[],
): void {
  const text = sectionText(sections, "一级发行");
  if (text === sectionText(original, "一级发行")) return;
  const before = JSON.stringify([data.primary_issues, data.primary_summary]);
  const parsed: PrimaryIssueDetail[] = [];
  let category = "";
  for (const rawLine of sections.get("一级发行") ?? []) {
    const line = rawLine.trim();
    if (!line || line.startsWith("可比证券公司发行情况:")) continue;
    if (line.endsWith(":")) {
      category = line.slice(0, -1).trim();
      continue;
    }
    if (line === "今日暂无。") continue;
    const match = line.match(
      /^(\d{2}\/\d{2})-(.+)-(.+)-([\d,.]+亿|规模暂缺)-(.+)$/,
    );
    if (!match || !category) {
      issues.push(`【一级发行】无法识别：${line}`);
      continue;
    }
    const issueDate = match[1]!;
    const issuer = match[2]!.trim();
    const tenors = match[3]!.split("/").map((value) => value.trim());
    const existing = data.primary_issues.find(
      (row) =>
        row.issue_date === issueDate
        && row.issuer === issuer
        && row.category === category,
    ) ?? data.primary_issues.find(
      (row) =>
        row.issue_date === issueDate
        && row.category === category
        && row.tenors.join("/") === tenors.join("/"),
    );
    parsed.push({
      issue_date: issueDate,
      issue_date_key: inferDateKey(issueDate, data.report_date),
      issuer,
      category,
      bond_names: existing?.bond_names ?? [],
      tenors,
      amount:
        match[4] === "规模暂缺" ? null :
        existing && existing.amount !== null && match[4]!.replace(/[亿,]/g, "") === String(Math.round(existing.amount))
          ? existing.amount
          : Number(match[4]!.replace(/[亿,]/g, "")),
      coupons:
        existing && match[5] === formatPrimaryCoupons(existing.coupons)
          ? existing.coupons
          : match[5]!.split("/").map((value) => {
              const normalized = value.trim();
              return normalized === "-"
                ? null
                : Number(normalized.replace("%", ""));
            }),
    });
  }
  if (issues.some((issue) => issue.startsWith("【一级发行】"))) return;
  data.primary_issues = parsed;
  const current = parsed
    .filter((row) => row.issue_date_key === data.report_date)
    .reduce<number | null>((sum, row) => sum === null || row.amount === null ? null : sum + row.amount, 0);
  const previous = parsed
    .filter((row) => row.issue_date_key !== data.report_date)
    .reduce<number | null>((sum, row) => sum === null || row.amount === null ? null : sum + row.amount, 0);
  data.primary_summary = {
    current_amount: current,
    change_amount: current === null || previous === null ? null : current - previous,
  };
  if (before === JSON.stringify([data.primary_issues, data.primary_summary])) {
    issues.push("【一级发行】未识别到可回写的数据修改");
  }
}

function updateSecondary(
  data: ReportData,
  sections: Map<string, string[]>,
  original: Map<string, string[]>,
  issues: string[],
): void {
  const text = sectionText(sections, "二级行情");
  if (text === sectionText(original, "二级行情")) return;
  const before = JSON.stringify([
    data.secondary_bonds,
    data.inventory_bonds,
  ]);
  const lines = sections.get("二级行情") ?? [];
  const inventoryStart = lines.findIndex((line) =>
    line.startsWith("东财存量债券:")
  );
  if (inventoryStart < 0) {
    issues.push("【二级行情】缺少东财存量债券段落");
    return;
  }

  const secondaryLines = lines
    .slice(0, inventoryStart)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !line.startsWith("可比证券公司债券成交")
      && line !== "今日暂无。"
    );
  for (const line of secondaryLines) {
    const parsed = parseSecondaryLine(line, data.secondary_bonds);
    if (!parsed) issues.push(`【二级行情】无法识别：${line}`);
    else {
      const index = data.secondary_bonds.findIndex(
        (row) => row.bond_name === parsed.bond_name,
      );
      if (index < 0) data.secondary_bonds.push(parsed);
      else data.secondary_bonds[index] = parsed;
    }
  }

  const inventory: InventoryPoint[] = [];
  for (const rawLine of lines.slice(inventoryStart + 1)) {
    const line = rawLine.trim();
    if (!line || line === "今日暂无。") continue;
    const parsed = parseInventoryLine(line, data.inventory_bonds);
    if (!parsed) issues.push(`【二级行情】无法识别：${line}`);
    else inventory.push(parsed);
  }
  if (!issues.some((issue) => issue.startsWith("【二级行情】"))) {
    data.inventory_bonds = inventory;
    if (before === JSON.stringify([
      data.secondary_bonds,
      data.inventory_bonds,
    ])) {
      issues.push("【二级行情】未识别到可回写的数据修改");
    }
  }
}

function parseSecondaryLine(
  line: string,
  existingRows: SecondaryBond[],
): SecondaryBond | null {
  const match = line.match(
    /^(.+)-(.+)\((.+)\)-估值(-?\d+(?:\.\d+)?)%-成交(-?\d+(?:\.\d+)?)%$/,
  );
  if (!match) return null;
  const existing = existingRows.find((row) => row.bond_name === match[3]);
  if (existing && line === secondaryBondLine(existing)) return existing;
  return {
    bond_id: existing?.bond_id ?? match[3]!,
    bond_name: match[3]!,
    issuer: match[2]!,
    tenor_label: normalizeTenorLabel(match[1]!),
    tenor_years: parseTenorYears(match[1]!),
    valuation: Number(match[4]),
    trade_yield: Number(match[5]),
  };
}

function parseInventoryLine(
  line: string,
  existingRows: InventoryPoint[],
): InventoryPoint | null {
  const match = line.match(
    /^(.+)-([^-]+)-估值(-?\d+(?:\.\d+)?|--)%(?:-(.*))?$/,
  );
  if (!match || match[3] === "--") return null;
  const existing = existingRows.find((row) => row.bond_name === match[2]);
  if (existing && line === emBondLine(existing)) return existing;
  const quote = match[4] ?? "";
  const trade = quote.match(/^成交(-?\d+(?:\.\d+)?)%(?:\(([+-]?\d+(?:\.\d+)?)bp\))?$/);
  const bid = quote.match(/(?:^|-)Bid(-?\d+(?:\.\d+)?)%/);
  const ofr = quote.match(/(?:^|-)Ofr(-?\d+(?:\.\d+)?)%/);
  return {
    bond_name: match[2]!,
    tenor_label: normalizeTenorLabel(match[1]!),
    tenor_years: parseTenorYears(match[1]!),
    valuation: Number(match[3]),
    trade_yield: trade ? Number(trade[1]) : null,
    trade_spread_bp: trade?.[2] === undefined ? null : Number(trade[2]),
    bid_yield: bid ? Number(bid[1]) : existing?.bid_yield ?? null,
    ofr_yield: ofr ? Number(ofr[1]) : existing?.ofr_yield ?? null,
  };
}

function reportSections(value: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let active = "";
  for (const line of normalizeTextReport(value).split("\n")) {
    const heading = line.match(/^【(.+)】$/)?.[1];
    if (heading) {
      active = heading;
      result.set(active, []);
    } else if (active) {
      result.get(active)!.push(line);
    }
  }
  return result;
}

function sectionText(sections: Map<string, string[]>, name: string): string {
  return normalizeTextReport((sections.get(name) ?? []).join("\n"));
}

function normalizeProtectedDerivedText(
  section: typeof REQUIRED_SECTIONS[number],
  edited: string,
  original: string,
  regenerated: string,
): string {
  const patterns = section === "央行"
    ? [/；净(?:投放(?:为零|\d+(?:\.\d+)?亿元)|回笼\d+(?:\.\d+)?亿元)。$/m]
    : section === "利率"
      ? [
          /^今日银行间隔夜和7天期利率[^。\n]+。/m,
          /^国债收益率[^。\n]+。/m,
          /^国债期货[^，。\n]+，/m,
        ]
      : [];
  return patterns.reduce(
    (value, pattern) => replaceUneditedDerivedFragment(
      value,
      original,
      regenerated,
      pattern,
    ),
    edited,
  );
}

function replaceUneditedDerivedFragment(
  edited: string,
  original: string,
  regenerated: string,
  pattern: RegExp,
): string {
  const originalFragment = original.match(pattern)?.[0];
  const regeneratedFragment = regenerated.match(pattern)?.[0];
  if (
    !originalFragment
    || !regeneratedFragment
    || originalFragment === regeneratedFragment
    || !edited.includes(originalFragment)
  ) {
    return edited;
  }
  return edited.replace(originalFragment, regeneratedFragment);
}

function cloneReport(data: ReportData): ReportData {
  return structuredClone(data);
}

function normalizeDuration(value: string): string {
  return value
    .replace("天", "D")
    .replace("月", "M")
    .replace("年", "Y");
}

function normalizeTenorLabel(value: string): string {
  return value.replace("天", "D").replace("年", "Y");
}

function parseTenorYears(value: string): number {
  const parsed = Number(value.replace(/(?:天|年)$/, ""));
  return value.endsWith("天") ? parsed / 365 : parsed;
}

function parseNullableNumber(value: string): number | null {
  return value === "--" ? null : Number(value);
}

function parseDirection(
  value: string,
  upWord: string,
  downWord: string,
): number {
  if (value.includes("持平")) return 0;
  const amount = Number(value.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
  return value.startsWith(downWord) ? -amount : value.startsWith(upWord) ? amount : 0;
}

function parseAmountChange(value: string): number | null {
  if (value === "数据暂缺") return null;
  const amount = Number(value.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
  return value.startsWith("减少") ? -amount : amount;
}

function inferDateKey(label: string, reportDate: string): string {
  const reportYear = Number(reportDate.slice(0, 4));
  const reportMonthDay = reportDate.slice(5).replace("-", "/");
  const year = label > reportMonthDay ? reportYear - 1 : reportYear;
  return `${year}-${label.replace("/", "-")}`;
}

function upsertFunding(rows: FundingRate[], value: FundingRate): void {
  const index = rows.findIndex((row) => row.code === value.code);
  if (index < 0) rows.push(value);
  else rows[index] = value;
}

function upsertGovernment(
  rows: GovernmentBond[],
  value: GovernmentBond,
): void {
  const index = rows.findIndex(
    (row) => row.category === value.category && row.tenor === value.tenor,
  );
  if (index < 0) rows.push(value);
  else rows[index] = value;
}

function upsertFuture(rows: BondFuture[], value: BondFuture): void {
  const index = rows.findIndex((row) => row.code === value.code);
  if (index < 0) rows.push(value);
  else rows[index] = value;
}
