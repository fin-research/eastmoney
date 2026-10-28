const DAY_MS = 86_400_000;

export interface CalendarDay {
  date: string;
  day: number;
  inMonth: boolean;
}

export interface LedgerCalendarDay extends CalendarDay {
  hasLedger: boolean;
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function shiftMonth(month: string, offset: number): string {
  const date = parseIso(monthStart(month));
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

export function monthLabel(month: string): string {
  const [year, value] = month.split("-");
  return `${year}年${Number(value)}月`;
}

export function calendarDays(month: string): CalendarDay[] {
  const first = parseIso(monthStart(month));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.valueOf() - mondayOffset * DAY_MS);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.valueOf() + index * DAY_MS);
    const iso = date.toISOString().slice(0, 10);
    return {
      date: iso,
      day: date.getUTCDate(),
      inMonth: iso.slice(0, 7) === month.slice(0, 7),
    };
  });
}

export function calendarDaysWithLedgerStatus(
  month: string,
  ledgerDates: string[],
): LedgerCalendarDay[] {
  const dates = new Set(ledgerDates);
  return calendarDays(month).map((day) => ({
    ...day,
    hasLedger: dates.has(day.date),
  }));
}

export function shiftDate(value: string, offset: number): string {
  return new Date(parseIso(value).valueOf() + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function resolveAvailableRange(
  dates: string[],
  requestedStart: string,
  requestedEnd: string,
  fallbackStart: string,
  fallbackEnd: string,
): { startDate: string; endDate: string; fellBack: boolean } | null {
  const sorted = [...new Set(dates)].sort();
  if (!sorted.length) return null;
  if (sorted.some((date) => date >= requestedStart && date <= requestedEnd)) {
    return {
      startDate: requestedStart,
      endDate: requestedEnd,
      fellBack: false,
    };
  }
  const fallbackDates = sorted.filter(
    (date) => date >= fallbackStart && date <= fallbackEnd,
  );
  if (!fallbackDates.length) return null;
  return {
    startDate: fallbackStart,
    endDate: fallbackEnd,
    fellBack: true,
  };
}

function parseIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}
