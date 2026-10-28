/** Read-only Cloudflare resource metrics. Never fetches secrets or message bodies. */
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node --use-env-proxy scripts/audit-cloud-resources.mjs <from-ISO> <to-ISO> <output.json>');
  process.exit(0);
}
const [from, to, output] = args;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token || !output ||
    !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > 31 * 86400_000) {
  throw new Error('Provide account/token, an increasing ISO timeframe of at most 31 days, and an output path. See --help.');
}
const start = new Date(from).toISOString(), end = new Date(to).toISOString();
const filter = `filter:{datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}}`;
// Separate datasets so an unavailable product does not hide other measurements.
const queries = {
  workers: `workersInvocationsAdaptive(limit:2000,${filter}){dimensions{date scriptName status}sum{requests errors subrequests cpuTimeUs}quantiles{cpuTimeP50 cpuTimeP95 wallTimeP50 wallTimeP95}}`,
  d1: `d1AnalyticsAdaptiveGroups(limit:1000,${filter}){dimensions{date databaseId}sum{readQueries writeQueries rowsRead rowsWritten}quantiles{queryBatchTimeMsP95}}`,
  hyperdrive: `hyperdriveQueriesAdaptiveGroups(limit:1000,${filter}){count dimensions{date configId cacheStatus eventStatus}avg{connectionLatency queryLatency}sum{queryBytes resultBytes}}`,
  pools: `hyperdrivePoolSizesAdaptiveGroups(limit:1000,${filter}){dimensions{date configId}avg{currentPoolSize waitingClients}max{currentPoolSize maxPoolSize waitingClients}}`,
  r2: `r2OperationsAdaptiveGroups(limit:1000,${filter}){dimensions{date bucketName actionType}sum{requests responseBytes}}`,
  queues: `queueMessageOperationsAdaptiveGroups(limit:1000,${filter}){dimensions{date queueId actionType outcome}sum{billableOperations}}`,
  workflows: `workflowsAdaptiveGroups(limit:1000,${filter}){dimensions{date workflowName}sum{cpuTime retryCount stepCount storageRate}}`,
  builds: `workersBuildsBuildMinutesAdaptiveGroups(limit:32,${filter}){dimensions{date}sum{buildMinutes}}`,
  ai: `aiGatewayRequestsAdaptiveGroups(limit:1000,${filter}){count dimensions{date model provider gateway}sum{cost tokensIn tokensOut erroredRequests cachedRequests}}`,
  neurons: `aiInferenceAdaptiveGroups(limit:1000,${filter}){count dimensions{date modelId}sum{totalNeurons totalInferenceTimeMs totalInputTokens totalOutputTokens}}`,
  durableObjects: `durableObjectsPeriodicGroups(limit:1000,${filter}){dimensions{date namespaceId}sum{cpuTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors}}`
};
const results = await Promise.allSettled(Object.entries(queries).map(async ([name, selection]) => {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){${selection}}}}` })
  });
  if (!response.ok) return [name, { available: false, httpStatus: response.status }];
  const data = await response.json();
  if (data.errors?.length) return [name, { available: false, errors: data.errors.map(error => error.message) }];
  const accountData = data.data?.viewer?.accounts?.[0];
  if (!accountData) return [name, { available: false, reason: 'Account metrics unavailable' }];
  const rows = Object.values(accountData)[0];
  const limit = Number(selection.match(/limit:(\d+)/)[1]);
  return [name, { available: true, potentiallyTruncated: rows.length >= limit, rows }];
}));
const datasets = Object.fromEntries(results.map((result, index) => result.status === 'fulfilled'
  ? result.value
  : [Object.keys(queries)[index], { available: false, reason: 'Network request failed or timed out' }]));
await writeFile(output, JSON.stringify({ collectedAt: new Date().toISOString(), from: start, to: end,
  notes: ['Adaptive analytics are estimates, not invoices.', 'Daily groups use UTC; partial days must not be compared as full days.',
    'Empty datasets are not evidence of zero usage.', 'AI custom-provider cost=0 may mean pricing is unavailable.',
    'Workers GraphQL CPU and wall-time values are microseconds.'], datasets }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(Object.fromEntries(Object.entries(datasets).map(([key, value]) =>
  [key, { available: value.available, rows: value.rows?.length, potentiallyTruncated: value.potentiallyTruncated }]))));
