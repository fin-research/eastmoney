const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export function currentReportDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function shouldWarnUnfinalizedReport(
  reportDate: string,
  finalizedAt: string | null,
  currentDate = currentReportDate(),
): boolean {
  return !finalizedAt && reportDate < currentDate;
}

export function isBeforeReportCutoff(now = new Date()): boolean {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE, hour: "2-digit", hourCycle: "h23",
  }).format(now)) < 17;
}

export function previousReportTradingDate(tradingDates: string[], today: string): string {
  const date = tradingDates.filter(date => date < today).sort().at(-1);
  if (!date) throw new Error("无法确定上一交易日，请稍后重试");
  return date;
}
