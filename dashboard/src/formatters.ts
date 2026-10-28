const compactNumber = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

export function number(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return (value as number).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function compact(
  value: number | null | undefined,
  suffix = "",
): string {
  if (!Number.isFinite(value)) return "—";
  return `${compactNumber.format(value as number)}${suffix}`;
}

export function integer(
  value: number | null | undefined,
  suffix = "",
): string {
  if (!Number.isFinite(value)) return "—";
  return `${number(value, 0)}${suffix}`;
}

export function signed(
  value: number | null | undefined,
  suffix = "",
  digits = 2,
): string {
  if (!Number.isFinite(value)) return "—";
  const numeric = value as number;
  const sign = numeric > 0 ? "+" : numeric < 0 ? "−" : "";
  return `${sign}${number(Math.abs(numeric), digits)}${suffix}`;
}

export function formatOmoNetAmount(
  value: number | null | undefined,
): string {
  return signed(value, " 亿", 0);
}

export function tone(
  value: number | null | undefined,
): "up" | "down" | "flat" {
  if (!Number.isFinite(value) || value === 0) return "flat";
  return (value as number) > 0 ? "up" : "down";
}

export function chineseDateParts(
  isoDate: string,
): { date: string; weekday: string } {
  const date = new Date(`${isoDate}T00:00:00`);
  const weekday = "日一二三四五六"[date.getDay()];
  return {
    date: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    weekday: `星期${weekday}`,
  };
}

export function timeLabel(isoDateTime: string | null): string {
  if (!isoDateTime) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoDateTime));
}

export function shortDate(isoDate: string): string {
  return isoDate.slice(5).replace("-", ".");
}
