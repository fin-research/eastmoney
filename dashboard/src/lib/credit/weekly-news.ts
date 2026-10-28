import type { CreditWeeklyNewsItem } from "./types.ts";

export function formatCreditWeeklyNews(news: CreditWeeklyNewsItem): string {
  const totalAmount = news.currentStatus === null
    ? news.previousAmount
    : news.currentAmount;
  const expiryDate = news.currentExpiryDate ?? news.previousExpiryDate;

  if (news.eventType === "new") {
    return sentence([
      `${news.institutionName}新增授信批复`,
      `总额${formatAmount(totalAmount)}亿`,
      dateDetail("起始日", news.currentEffectiveDate),
      dateDetail("到期日", expiryDate),
    ]);
  }
  if (news.eventType === "increase") {
    return sentence([
      `${news.institutionName}授信扩额完成`,
      `总额${formatAmount(totalAmount)}亿`,
      comparisonDetail(news.deltaAmount),
      dateDetail("到期日", expiryDate),
    ]);
  }
  if (news.eventType === "decrease" || news.eventType === "amendment") {
    return sentence([`${news.institutionName}授信${news.eventType === "decrease" ? "缩额" : "调整"}`,`总额${formatAmount(totalAmount)}亿`,comparisonDetail(news.deltaAmount),dateDetail("到期日",expiryDate)]);
  }
  if (news.eventType === "renewal") {
    return sentence([
      `${news.institutionName}授信续作完成`,
      `总额${formatAmount(totalAmount)}亿`,
      comparisonDetail(news.deltaAmount),
      dateDetail("到期日", expiryDate),
    ]);
  }
  if (news.eventType === "expiry") {
    return sentence([
      `${news.institutionName}授信到期`,
      `总额${formatAmount(totalAmount)}亿`,
      dateDetail("到期日", expiryDate),
    ]);
  }
  return sentence([
    `${news.institutionName}授信撤销`,
    `原总额${formatAmount(news.previousAmount || totalAmount)}亿`,
    dateDetail("撤销日", news.reportDate),
  ]);
}

function formatAmount(value: number): string {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatChineseDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function comparisonDetail(deltaAmount: number): string {
  if (Math.abs(deltaAmount) < 0.0001) return "较前额一致";
  return deltaAmount > 0
    ? `较前额增加${formatAmount(deltaAmount)}亿`
    : `较前额减少${formatAmount(Math.abs(deltaAmount))}亿`;
}

function dateDetail(label: string, value: string | null): string | null {
  return value ? `${label}${formatChineseDate(value)}` : null;
}

function sentence(parts: Array<string | null>): string {
  return `${parts.filter(Boolean).join("，")}。`;
}
