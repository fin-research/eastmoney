export const PRIMARY_CATEGORY_ORDER = [
  "短融",
  "公募短债",
  "小公募",
  "次级债",
  "私募债",
] as const;

export function formatPrimaryAmount(value: number | null): string {
  if (value === null) return "规模暂缺";
  return `${Math.round(value).toLocaleString("zh-CN")}亿`;
}

export function formatPrimaryCoupons(values: Array<number | null>): string {
  return values
    .map((value) => (value === null ? "-" : `${value.toFixed(2)}%`))
    .join("/");
}
