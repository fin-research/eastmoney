import { Client } from "pg";
import { z } from "zod";

import {
  fetchChoiceEconomicIndicatorRows,
  fetchDmFundingRateRows,
  type EconomicIndicatorSyncMode,
} from "../src/sync/economic-indicator-sync.ts";
import { persistEconomicIndicators } from "../src/sync/economic-indicators-repository.ts";

const choiceTableSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
});

const argumentsList = process.argv.slice(2);
if (!argumentsList.includes("--apply")) {
  throw new Error(
    "This command writes paid Choice EDB data. Re-run with --apply and choose --full or --incremental.",
  );
}
const mode: EconomicIndicatorSyncMode = argumentsList.includes("--full")
  ? "full"
  : "incremental";

const connectionString =
  process.env.DATABASE_URL ??
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required",
  );
}

const dataApiBaseUrl = resolveDataApiBaseUrl();
const quota = await loadQuota().catch((error) => ({
  error: error instanceof Error ? error.message : String(error),
}));
// Verify and exhaust the free DM history first so a missing route cannot waste
// the paid Choice request before the transaction is ready to be committed.
const dm = await fetchDmFundingRateRows(fetchChoiceTable, mode);
const choice = await fetchChoiceEconomicIndicatorRows(fetchChoiceTable, mode);
const rows = [...choice.rows, ...dm.rows];
const requestedCodes = [...choice.requestedCodes, ...dm.requestedCodes];

const client = new Client({
  connectionString,
  application_name: `eastmoney-edb-${mode}-sync`,
});
try {
  await client.connect();
  const result = await persistEconomicIndicators(client, rows, {
    replaceCodes: mode === "full" ? requestedCodes : undefined,
  });
  const coverage = await client.query<{
    code: string;
    row_count: string;
    first_observation: string;
    last_observation: string;
  }>(
    `SELECT
       indicator_code AS code,
       count(*)::text AS row_count,
       to_char(min(observation_date), 'YYYY-MM-DD') AS first_observation,
       to_char(max(observation_date), 'YYYY-MM-DD') AS last_observation
     FROM public.edb
     WHERE indicator_code = ANY($1::text[])
     GROUP BY indicator_code
     ORDER BY indicator_code`,
    [requestedCodes],
  );
  console.log(
    JSON.stringify(
      {
        mode,
        quota,
        range: choice.range,
        dmPages: dm.pageCount,
        storedRows: result.rowCount,
        requestedIndicators: requestedCodes.length,
        returnedIndicators:
          choice.returnedCodes.length + dm.returnedCodes.length,
        asOf: result.asOf,
        coverage: coverage.rows.map((row) => ({
          code: row.code,
          rowCount: Number(row.row_count),
          firstObservation: row.first_observation,
          lastObservation: row.last_observation,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await client.end().catch(() => undefined);
}

async function loadQuota(): Promise<Record<string, unknown>> {
  const { startDate, endDate } = currentWeekRange();
  const payload = choiceTableSchema.parse(
    await fetchChoiceTable(
      "/choice/data-statistics",
      new URLSearchParams({
        funcName: "EM_EDB",
        indicators:
          "FUNCENAME,PERIOD,STARTDATE,ENDDATE,THRESHOLD,USEDDATA,USEDRATIO,AVAILABEDATA",
        startDate,
        endDate,
      }),
    ),
  );
  const quota = payload.rows.find((row) => row.FUNCENAME === "EM_EDB");
  if (!quota) return { status: "not-returned" };
  return {
    period: quota.PERIOD,
    threshold: optionalNumber(quota.THRESHOLD),
    usedBefore: optionalNumber(quota.USEDDATA),
    availableBefore: optionalNumber(quota.AVAILABEDATA),
  };
}

async function fetchChoiceTable(
  path: string,
  searchParams: URLSearchParams,
): Promise<unknown> {
  const url = new URL(`${dataApiBaseUrl}${path}`);
  url.search = searchParams.toString();
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(
      `Data API request failed: ${path} (HTTP ${response.status})${details ? `: ${details}` : ""}`,
    );
  }
  return response.json();
}

function resolveDataApiBaseUrl(): string {
  const configured = process.env.DATA_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const proxyTarget = process.env.DATA_PROXY_TARGET?.trim();
  if (proxyTarget) return `${proxyTarget.replace(/\/$/, "")}/data`;
  return "https://eastmoney.hasbai.xyz/data";
}

function currentWeekRange(now = new Date()): {
  startDate: string;
  endDate: string;
} {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const weekday = end.getUTCDay() || 7;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - weekday + 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function optionalNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
