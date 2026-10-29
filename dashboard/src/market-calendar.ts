// SSE 2026 closure notice, including weekends regardless of government make-up working days:
// https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml
const CLOSURES: Record<string, readonly (readonly [string, string])[]> = {
  "2026": [["01-01","01-03"], ["02-15","02-23"], ["04-04","04-06"], ["05-01","05-05"],
    ["06-19","06-21"], ["09-25","09-27"], ["10-01","10-07"]],
};

/** null means the year has not yet been verified, never a guessed holiday. */
export function knownMarketClosure(date: string): boolean | null {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return true;
  const closures = CLOSURES[date.slice(0, 4)];
  if (!closures) return null;
  return closures.some(([start, end]) => date.slice(5) >= start && date.slice(5) <= end);
}
