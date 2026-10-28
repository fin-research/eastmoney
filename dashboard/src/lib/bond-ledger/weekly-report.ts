export function yearToLatestLedgerRange(today: string, databaseDates: string[]) {
  const startDate = `${today.slice(0, 4)}-01-01`;
  const latest = databaseDates
    .filter((date) => date >= startDate && date <= today)
    .sort()
    .at(-1);
  return { startDate, endDate: latest ?? today };
}
