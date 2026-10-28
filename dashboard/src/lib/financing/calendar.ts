/** Six complete calendar rows; hiding weekends must retain each weekday's column. */
export function financingCalendarDates(month: string, includeWeekends: boolean): string[] {
  const start = new Date(`${month}-01T00:00:00Z`);
  const offset = includeWeekends ? start.getUTCDay() : (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  const columns = includeWeekends ? 7 : 5;
  return Array.from({ length: 6 * columns }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + Math.floor(index / columns) * 7 + index % columns);
    return date.toISOString().slice(0, 10);
  });
}
