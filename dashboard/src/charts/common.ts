function rootStyle(): CSSStyleDeclaration | null {
  if (
    typeof document === "undefined" ||
    typeof getComputedStyle === "undefined"
  ) {
    return null;
  }
  return getComputedStyle(document.documentElement);
}

function cssColor(name: string, fallback: string): string {
  return rootStyle()?.getPropertyValue(name).trim() || fallback;
}

export const colors = {
  ink: cssColor("--text-1", cssColor("--ink", "#202622")),
  muted: cssColor("--text-3", cssColor("--text-muted", "#667069")),
  quiet: cssColor("--quiet", "#8d9690"),
  line: cssColor("--chart-line-color", "#ffffff"),
  grid: cssColor("--chart-grid-color", "#ffffff"),
  zero: cssColor("--border-strong", "#9da59f"),
  paper: cssColor("--bg-card", cssColor("--surface", "#ffffff")),
  brand: cssColor("--color-primary", cssColor("--brand", "#f47a20")),
  brandSoft: cssColor("--color-primary-soft", cssColor("--brand-soft", "#fff0e5")),
  red: cssColor("--red", "#d92d20"),
  green: cssColor("--green", "#12a873"),
  get up() {
    return cssColor("--color-up", "#d92d20");
  },
  get down() {
    return cssColor("--color-down", "#12a873");
  },
  gold: cssColor("--business-accent", cssColor("--gold", "#f47a20")),
  blue: cssColor("--color-primary", cssColor("--blue", "#3f708c")),
} as const;

export const fontFamily =
  rootStyle()?.getPropertyValue("--font").trim() ||
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export function rem(value: number): number {
  const rootSize = Number.parseFloat(rootStyle()?.fontSize ?? "");
  return value * (Number.isFinite(rootSize) ? rootSize : 16);
}

const configuredChartTextSize = Number.parseFloat(
  rootStyle()?.getPropertyValue("--chart-font-size") ?? "",
);
export const chartTextSize = Number.isFinite(configuredChartTextSize)
  ? configuredChartTextSize
  : rem(1);

export const axisLabel = {
  color: colors.muted,
  fontFamily,
  fontSize: chartTextSize,
  fontWeight: "normal" as const,
};

export const tooltip = {
  confine: true,
  className: "chart-tooltip",
  backgroundColor: "rgba(27, 33, 30, 0.96)",
  borderWidth: 0,
  padding: [6, 8],
  textStyle: {
    color: "#fffefa",
    fontFamily,
    fontSize: Math.max(chartTextSize, 12),
    lineHeight: rem(1.25),
  },
  extraCssText:
    "width:max-content;max-width:calc(100% - 1rem);white-space:normal;overflow-wrap:anywhere;word-break:break-word;box-shadow:0 0.5rem 1.75rem rgba(27,33,30,.18);",
};

export const gridLine = {
  color: colors.grid,
  type: "dashed" as const,
};

export const zeroLine = {
  color: colors.zero,
  width: 1.4,
  type: "solid" as const,
};

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function heatColor(change: number, maxAbs: number): string {
  if (Math.abs(change) < 0.005) return "#e8edf4";
  const neutral = [226, 232, 241];
  const target = colorChannels(change > 0 ? colors.up : colors.down);
  const ratio = Math.min(1, Math.abs(change) / maxAbs);
  const strength = 0.2 + ratio ** 0.58 * 0.8;
  return `rgb(${neutral
    .map((value, index) =>
      Math.round(value + ((target[index] ?? value) - value) * strength),
    )
    .join(",")})`;
}

function colorChannels(value: string): [number, number, number] {
  const match = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  return match
    ? [
        Number.parseInt(match[1] as string, 16),
        Number.parseInt(match[2] as string, 16),
        Number.parseInt(match[3] as string, 16),
      ]
    : [47, 111, 214];
}

export function heatTextColor(change: number, maxAbs: number): string {
  const ratio = Math.min(1, Math.abs(change) / maxAbs);
  const strength = 0.2 + ratio ** 0.58 * 0.8;
  return strength > 0.52 ? "#ffffff" : colors.ink;
}
