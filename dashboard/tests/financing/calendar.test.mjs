import test from 'node:test';
import assert from 'node:assert/strict';
import { financingCalendarDates } from '../../src/lib/financing/calendar.ts';

test('weekday calendar keeps September 8 in Tuesday and skips both weekend dates', () => {
  const dates = financingCalendarDates('2026-09', false);
  assert.deepEqual(dates.slice(0, 10), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  ]);
  assert.equal(dates.indexOf('2026-09-25') % 5, 4);
});

test('Sunday-starting months retain all working days and leap February includes the 29th', () => {
  assert.equal(financingCalendarDates('2025-06', false)[0], '2025-05-26');
  assert.ok(financingCalendarDates('2025-06', false).includes('2025-06-30'));
  assert.ok(financingCalendarDates('2024-02', false).includes('2024-02-29'));
});

test('both calendar modes preserve date coverage and weekday columns across three years', () => {
  for (let year = 2024; year <= 2026; year++) for (let month = 1; month <= 12; month++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    for (const weekends of [false, true]) {
      const dates = financingCalendarDates(key, weekends);
      const columns = weekends ? 7 : 5;
      assert.equal(new Set(dates).size, 6 * columns);
      dates.forEach((date, i) => assert.equal(new Date(`${date}T00:00:00Z`).getUTCDay(), i % columns + (weekends ? 0 : 1)));
      for (let day = 1; day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); day++) {
        const date = `${key}-${String(day).padStart(2, '0')}`;
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (weekends || (weekday > 0 && weekday < 6)) assert.ok(dates.includes(date), date);
      }
    }
  }
});
