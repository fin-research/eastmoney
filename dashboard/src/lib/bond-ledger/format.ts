export function formatYi(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value / 100_000_000).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} 亿元`;
}

export function formatWan(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value / 10_000).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} 万元`;
}

export function formatSignedWan(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${formatWan(Math.abs(value))}`;
}

export function formatDecimalPercent(
  value: number | null,
  digits = 2,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMultiple(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} 倍`;
}

export function formatYield(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatYears(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)} 年`;
}
