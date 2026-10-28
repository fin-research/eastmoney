// Shared row parsing helpers used by the text-report replica and the visual
// Shared numeric and text helpers retained by report formatting and legacy parsers.

export type Row = Record<string, unknown>;

export function string(value: unknown): string {
  return value == null ? "" : String(value);
}

export function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\d.\-]/g, "");
  if (!cleaned || ["-", ".", "-."].includes(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function strictNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasValue(value: unknown): boolean {
  return (
    value != null && !["", "--", "None", "nan"].includes(string(value).trim())
  );
}

export function secondaryTenorYears(value: unknown): number | null {
  const match = string(value)
    .trim()
    .toUpperCase()
    .match(/^([0-9]+(?:\.[0-9]+)?)([YD]).*$/);
  return match ? Number(match[1]) / (match[2] === "D" ? 365 : 1) : null;
}

export function parseTenorDays(value: unknown): number {
  const match = string(value)
    .trim()
    .toUpperCase()
    .match(/^([0-9]+(?:\.[0-9]+)?)([YD]).*$/);
  return match ? Number(match[1]) * (match[2] === "D" ? 1 : 365) : 0;
}

export function isPublicBond(value: string): boolean {
  const bond = value.trim().split(" ")[0] ?? "";
  return !!bond && (bond.includes("G") || !/[A-Za-z]/.test(bond));
}

export function isEastmoneyText(value: unknown): boolean {
  const text = string(value);
  return text.includes("东财") || text.includes("东方财富");
}

export function normalizeCompany(value: unknown): string {
  const text = string(value).replace(/\s+/g, "");
  return text === "安信证券" ? "国投证券" : text;
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
