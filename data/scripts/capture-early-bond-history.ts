/** Executes an explicitly frozen CSS matrix. No retries, no database writes. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { historicalCells, type HistoryRequest } from '../src/sync/bond-history-restoration.ts';
import { requireBondBudget } from '../src/sync/bond-history-sync.ts';

const [directory, sessionFile, quotaFile, confirmation] = process.argv.slice(2);
if (!directory || !sessionFile || !quotaFile || confirmation !== '--execute')
  throw Error('Usage: capture-early-bond-history.ts CACHE_DIR SESSION_FILE FRESH_QUOTA_FILE --execute');
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const planBytes = await readFile(path.join(directory, 'collection-plan.json'), 'utf8');
const plan = JSON.parse(planBytes) as { newPoints: number; priorProbePoints: number; maximumPoints: number;
  maximumCalls: number; retriesPerBatch: number; stopAfterConsecutiveFailures: number; requests: HistoryRequest[] };
const points = plan.requests.reduce((sum, r) => sum + r.codes.length * r.indicators.length, 0);
if (plan.newPoints !== points || plan.maximumPoints !== 300000 || points + plan.priorProbePoints > 300000
  || plan.requests.length !== plan.maximumCalls || plan.retriesPerBatch !== 0 || plan.stopAfterConsecutiveFailures !== 3
  || plan.requests.some(r => r.codes.length > 200 || !r.codes.length || r.date < '2019-01-02'
    || r.date > '2020-11-05' || r.options !== `EndDate=${r.date},CredType=1,Ispandas=1`)) throw Error('Unbounded collection plan');
const quota = JSON.parse(await readFile(quotaFile, 'utf8'));
if (quota.status !== 200 || Date.now() - Date.parse(quota.time) > 15 * 60000 || Date.parse(quota.time) > Date.now())
  throw Error('Fresh quota evidence required');
requireBondBudget(JSON.parse(quota.rawBody), new Date().toISOString().slice(0, 10), points);
const headers = JSON.parse(await readFile(sessionFile, 'utf8')) as Record<string, string>;
await mkdir(path.join(directory, 'responses'), { recursive: true });
let attemptedPoints = plan.priorProbePoints, failed = 0, failures = 0, successful = 0, calls = 0;
for (let index = 0; index < plan.requests.length; index++) {
  const request = plan.requests[index]!;
  const target = path.join(directory, 'responses', `${String(index).padStart(4, '0')}.json`);
  // An existing receipt, including a failure/unknown execution, is never re-requested.
  try { await access(target); throw Error(`Existing receipt ${index}; use offline verification, never replay`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const params = { codes: request.codes.join(','), indicators: request.indicators.join(','), options: request.options };
  const receipt: Record<string, unknown> = { planSha256: hash(planBytes), index, request,
    params, startedAt: new Date().toISOString(), status: null, rawBody: null, rawSha256: null };
  attemptedPoints += request.codes.length * request.indicators.length;
  calls++;
  // Write intent before sending: interruption cannot silently authorize a replay.
  await writeFile(target, JSON.stringify(receipt, null, 2));
  let stop = false;
  try {
    const response = await fetch('https://eastmoney.hasbai.xyz/data/choice/css?' + new URLSearchParams(params),
      { headers, signal: AbortSignal.timeout(90000), redirect: 'error' });
    receipt.status = response.status;
    receipt.rawBody = await response.text();
    receipt.rawSha256 = hash(receipt.rawBody as string);
    receipt.finishedAt = new Date().toISOString();
    if (response.ok) {
      historicalCells(JSON.parse(receipt.rawBody as string), request);
      failed = 0; successful++;
    } else {
      failed++; failures++;
      // Only these explicit upstream business failures may allow the next distinct batch.
      const businessFailure = /10000013|10000009|10003008/.test(receipt.rawBody as string);
      stop = [401, 403, 429].includes(response.status) || !businessFailure || failed >= 3;
    }
  } catch (error) { receipt.error = error instanceof Error ? error.message : String(error); failures++; stop = true; }
  await writeFile(target, JSON.stringify(receipt, null, 2));
  if (index % 25 === 0 || stop || index === plan.requests.length - 1) console.log(JSON.stringify({ index,
    calls, successful, failures, attemptedPoints, stop }));
  await writeFile(path.join(directory, 'collection-progress.json'), JSON.stringify({ updatedAt: new Date().toISOString(),
    planSha256: hash(planBytes), lastIndex: index, calls, successful, failures, attemptedPoints, stop }, null, 2));
  if (stop) break;
}
