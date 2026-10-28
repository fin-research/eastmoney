/** Capture only the explicit dates file, reusing successful raw responses. No database writes or Choice. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BROKER_CURVE_PROFILE, parseHistoricalDay } from '../src/sync/broker-curve-history.ts';
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw Error('Usage: capture-broker-curve-history.ts CACHE_DIR');
const dates: string[] = JSON.parse(await readFile(path.join(directory, 'dates.json'), 'utf8'));
if (!dates.length || dates.length > 2500 || new Set(dates).size !== dates.length || dates.some(date =>
  !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '2019-01-01' || date > '2026-10-22')) throw Error('Invalid controlled dates');
await mkdir(path.join(directory, 'daily'), { recursive: true });
let calls = 0, cached = 0;
const failures: Array<{ date: string; error: string }> = [];
for (const date of dates) {
  const file = path.join(directory, 'daily', `${date}.json`);
  const parameters = { xyzSelect: 'txy', workTimes: date, dxbj: '0', qxll: '0,', yqqxN: 'N', yqqxK: 'K',
    ycDefIds: BROKER_CURVE_PROFILE.curveCode, wrjxCBFlag: '0', locale: 'zh_CN' };
  try {
    const previous = JSON.parse(await readFile(file, 'utf8'));
    if (previous.status === 200 && typeof previous.rawBody === 'string'
      && previous.parameters?.workTimes === date && previous.parameters?.ycDefIds === parameters.ycDefIds) {
      parseHistoricalDay(JSON.parse(previous.rawBody), date); cached++; continue;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  calls++;
  try {
    const response = await fetch('https://yield.chinabond.com.cn/cbweb-mn/yc/searchYc', {
      method: 'POST', body: new URLSearchParams(parameters), headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15_000),
    });
    const rawBody = await response.text();
    await writeFile(file, JSON.stringify({ capturedAt: new Date().toISOString(), parameters,
      status: response.status, rawBody }));
    if (!response.ok) throw Error(`ChinaBond HTTP ${response.status}`);
    parseHistoricalDay(JSON.parse(rawBody), date);
  } catch (error) {
    failures.push({ date, error: String(error) });
    if (failures.length >= 3) break;
  }
  if (calls % 100 === 0) console.log(JSON.stringify({ calls, cached, last: date, failures: failures.length }));
  await new Promise(resolve => setTimeout(resolve, 200)); // One serial request, no retry loop.
}
await writeFile(path.join(directory, 'capture-receipt.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
  requestedDates: dates.length, calls, cached, failures, paidChoiceCalls: 0 }, null, 2));
if (failures.length) throw Error('Capture incomplete; inspect receipt before any recovery plan');
