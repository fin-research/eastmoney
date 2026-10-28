import type { CaptureDataResponse } from './css-response-evidence.ts';
import { z } from "zod";
import { historicalReleaseDate } from "./economic-release-evidence.ts";

import {
  ALL_ECONOMIC_INDICATORS,
  type EconomicIndicatorDefinition,
} from "./economic-indicator-definitions.ts";
import type { EconomicIndicatorSyncRow } from "./economic-indicators-repository.ts";

export type EconomicIndicatorSyncMode = "full" | "incremental";

export type EconomicIndicatorSyncParams = {
  scheduledTime: number;
  issuanceReplayOf?: string;
  bondHistoryRecoveryOf?: string;
  bondFieldObservationPlan?: string;
};

export type DataApiRequest = (
  path: string,
  searchParams: URLSearchParams,
  capture?: CaptureDataResponse,
) => Promise<unknown>;

export const DM_FUNDING_RATE_CODES = new Set([
  "E1300003", // DR001
  "E1300004", // DR007
  "E1704420", // R007
  'E1300079', // SHIBOR 3M from DM lastPrice
  'DM_SHIBOR_1W',
  'DM_SHIBOR_ON',
]);

export const dmFundingRateCodeMap = new Map([
  ["DR001", "E1300003"],
  ["DR007", "E1300004"],
  ["R007", "E1704420"],
  ['Shibor3M', 'E1300079'],
  ['Shibor1W', 'DM_SHIBOR_1W'],
  ['ShiborO/N', 'DM_SHIBOR_ON'],
]);

export const CHOICE_ECONOMIC_INDICATORS = ALL_ECONOMIC_INDICATORS.filter(
  (definition) => !DM_FUNDING_RATE_CODES.has(definition.code),
);

const choiceTableSchema = z.object({
  function: z.string(),
  fields: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
});

const dmHistorySchema = z.object({
  hasNextPage: z.boolean(),
  rows: z.array(
    z.object({
      bondCode: z.string(),
      capitalTime: z.union([z.number(), z.string()]),
      weightedYield: z.union([z.number(), z.string(), z.null()]),
      lastPrice: z.union([z.number(), z.string(), z.null()]).optional(),
    }),
  ),
});

const publishDateProxyByCode = new Map<string, string>([
  ["EMM00590832", "EMM00008445"],
  ["EMI01737210", "EMM00072301"],
  ["EMM01607812", "EMM00000012"],
  ["EMM00634721", "EMM00087086"],
  ["EMM00087129", "EMM00087086"],
]);

// Choice currently returns three isolated, reproducibly invalid observations for
// the state-owned-bank three-month NCD rate. Match the full source tuple so a
// corrected value for the same observation date can flow through normally.
const knownInvalidChoiceObservations = new Set([
  "E1704281:2026-03-06:2.575",
  "E1704281:2026-04-03:3.75",
  "E1704281:2026-04-15:2.575",
]);

export async function fetchChoiceEconomicIndicatorRows(
  request: DataApiRequest,
  mode: EconomicIndicatorSyncMode,
  now = new Date(),
): Promise<{
  rows: EconomicIndicatorSyncRow[];
  requestedCodes: string[];
  returnedCodes: string[];
  range: { startDate: string; endDate: string };
}> {
  const endDate = shanghaiDate(now);
  const batches = choiceRequestBatches(mode, endDate);
  const rawRows: Array<Record<string, unknown>> = [];

  for (const batch of batches) {
    const payload = choiceTableSchema.parse(
      await request(
        "/choice/edb",
        new URLSearchParams({
          edbIds: batch.definitions.map((definition) => definition.code).join(","),
          startDate: batch.startDate,
          endDate,
          options: "IsPublishDate=1,FixDate=0",
        }),
      ),
    );
    if (payload.function !== "EDB") {
      throw new Error(`Unexpected Choice function: ${payload.function}`);
    }
    rawRows.push(...payload.rows);
  }

  const rows = normalizeChoiceEconomicIndicatorRows(rawRows, endDate);
  const requestedCodes = CHOICE_ECONOMIC_INDICATORS.map(
    (definition) => definition.code,
  );
  const returnedCodes = [...new Set(rows.map((row) => row.code))].sort();
  if (mode === "full") {
    const returned = new Set(returnedCodes);
    const missingCodes = requestedCodes.filter((code) => !returned.has(code));
    if (missingCodes.length) {
      throw new Error(
        `Choice EDB response is missing indicators: ${missingCodes.join(",")}`,
      );
    }
  }

  return {
    rows,
    requestedCodes,
    returnedCodes,
    range: {
      startDate: batches.reduce(
        (earliest, batch) =>
          batch.startDate < earliest ? batch.startDate : earliest,
        batches[0]!.startDate,
      ),
      endDate,
    },
  };
}

export function normalizeChoiceEconomicIndicatorRows(
  rawRows: Array<Record<string, unknown>>,
  endDate: string,
  publishDateRows: Array<Record<string, unknown>> = rawRows,
): EconomicIndicatorSyncRow[] {
  const definitionsByCode = new Map(
    CHOICE_ECONOMIC_INDICATORS.map((definition) => [definition.code, definition]),
  );
  const publishedDatesBySeriesPeriod = new Map<string, string>();
  for (const row of publishDateRows) {
    const publishedDate = choicePublishedDate(row.PUBLISHDATE);
    if (!publishedDate || publishedDate > endDate) continue;
    publishedDatesBySeriesPeriod.set(
      seriesPeriodKey(stringField(row, "code"), stringField(row, "date")),
      publishedDate,
    );
  }

  const rowsByObservation = new Map<string, EconomicIndicatorSyncRow>();
  for (const row of rawRows) {
    const code = stringField(row, "code");
    const definition = definitionsByCode.get(code);
    if (!definition) continue;
    const observationDate = stringField(row, "date");
    const proxyCode = publishDateProxyByCode.get(code);
    const publishedDate =
      choicePublishedDate(row.PUBLISHDATE) ??
      (proxyCode
        ? publishedDatesBySeriesPeriod.get(
            seriesPeriodKey(proxyCode, observationDate),
          )
        : null);
    const fallbackDate =
      definition.frequency === "日频" || definition.frequency === "不定期"
        ? observationDate
        : null;
    const date = publishedDate ?? historicalReleaseDate(code, observationDate) ?? fallbackDate;
    if (!date || date > endDate) continue;
    if (row.RESULT === null || row.RESULT === undefined || row.RESULT === '') continue;
    const value = numericField(row, "RESULT");
    if (
      knownInvalidChoiceObservations.has(
        `${code}:${observationDate}:${value}`,
      )
    ) continue;
    const syncRow = {
      code,
      observationDate,
      date,
      value,
    };
    rowsByObservation.set(seriesPeriodKey(code, observationDate), syncRow);
  }

  const rows = [...rowsByObservation.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.observationDate.localeCompare(right.observationDate),
  );
  return rows;
}

const choiceObservationSchema = z.object({
  code: z.string(), date: z.string(),
  RESULT: z.union([z.number(), z.string(), z.null()]),
  PUBLISHDATE: z.union([z.number(), z.string(), z.null()]).optional(),
});
export type ChoiceEconomicIndicatorRawRow = z.infer<typeof choiceObservationSchema>;

export function parseChoiceEconomicIndicatorTable(payload: unknown): ChoiceEconomicIndicatorRawRow[] {
  const table = choiceTableSchema.parse(payload);
  if (table.function !== "EDB") throw new Error(`Unexpected Choice function: ${table.function}`);
  return table.rows.map((row) => choiceObservationSchema.parse(row));
}

export async function fetchDmFundingRateRows(
  request: DataApiRequest,
  mode: EconomicIndicatorSyncMode,
  now = new Date(),
  bondCodes: readonly string[] = [...dmFundingRateCodeMap.keys()],
): Promise<{
  rows: EconomicIndicatorSyncRow[];
  requestedCodes: string[];
  returnedCodes: string[];
  pageCount: number;
}> {
  const rowsByObservation = new Map<string, EconomicIndicatorSyncRow>();
  const incrementalStartDate = daysBefore(shanghaiDate(now), 14);
  let pageCount = 0;

  const selectedCodes = [...dmFundingRateCodeMap].filter(([code]) => bondCodes.includes(code));
  for (const [bondCode, indicatorCode] of selectedCodes) {
    let endCapitalTime = now.getTime();
    let previousEndCapitalTime = Number.POSITIVE_INFINITY;
    for (let page = 0; page < MAX_DM_FULL_HISTORY_PAGES; page += 1) {
      const payload = dmHistorySchema.parse(
        await request(
          "/cfets-histories",
          new URLSearchParams({
            bondCode,
            endCapitalTime: String(endCapitalTime),
            limit: "100",
            fields:
              "bondCode,capitalTime,weightedYield,lastPrice,weightedYieldUpDownValueBp",
          }),
        ),
      );
      pageCount += 1;
      let minimumCapitalTime = Number.POSITIVE_INFINITY;
      for (const row of payload.rows) {
        if (row.bondCode.toUpperCase() !== bondCode.toUpperCase()) continue;
        const capitalTime = Number(row.capitalTime);
        if (!Number.isFinite(capitalTime)) continue;
        minimumCapitalTime = Math.min(minimumCapitalTime, capitalTime);
        const rawValue = bondCode.startsWith('Shibor') ? row.lastPrice : row.weightedYield;
        if (rawValue === null || rawValue === undefined || rawValue === '') continue;
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        const observationDate = shanghaiDate(new Date(capitalTime));
        if (mode === "incremental" && observationDate < incrementalStartDate) {
          continue;
        }
        rowsByObservation.set(
          seriesPeriodKey(indicatorCode, observationDate),
          {
            code: indicatorCode,
            observationDate,
            date: observationDate,
            value,
          },
        );
      }

      if (mode === "incremental" || !payload.hasNextPage) break;
      if (
        !Number.isFinite(minimumCapitalTime) ||
        minimumCapitalTime >= previousEndCapitalTime
      ) {
        throw new Error(`DM ${bondCode} history pagination did not advance`);
      }
      previousEndCapitalTime = minimumCapitalTime;
      endCapitalTime = minimumCapitalTime - 1;
      if (page === MAX_DM_FULL_HISTORY_PAGES - 1) {
        throw new Error(`DM ${bondCode} history exceeded pagination safety limit`);
      }
    }
  }

  const rows = [...rowsByObservation.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.observationDate.localeCompare(right.observationDate),
  );
  const requestedCodes = selectedCodes.map(([, code]) => code);
  const returnedCodes = [...new Set(rows.map((row) => row.code))].sort();
  if (mode === "full") {
    const returned = new Set(returnedCodes);
    const missingCodes = requestedCodes.filter((code) => !returned.has(code));
    if (missingCodes.length) {
      throw new Error(
        `DM funding history is missing indicators: ${missingCodes.join(",")}`,
      );
    }
  }
  return { rows, requestedCodes, returnedCodes, pageCount };
}

export function choiceRequestBatches(
  mode: EconomicIndicatorSyncMode,
  endDate: string,
): Array<{ definitions: EconomicIndicatorDefinition[]; startDate: string }> {
  if (mode === "full") {
    const batches: Array<{
      definitions: EconomicIndicatorDefinition[];
      startDate: string;
    }> = [];
    // A single indicator can contain decades of daily observations. Keeping
    // full-history requests one series at a time avoids upstream 503s without
    // changing the incremental cron's frequency-based batching.
    for (let offset = 0; offset < CHOICE_ECONOMIC_INDICATORS.length; offset += 1) {
      batches.push({
        definitions: CHOICE_ECONOMIC_INDICATORS.slice(offset, offset + 1),
        startDate: "1899-01-01",
      });
    }
    return batches;
  }

  const definitionsByRequestGroup = new Map<
    string,
    { lookbackDays: number; definitions: EconomicIndicatorDefinition[] }
  >();
  for (const definition of CHOICE_ECONOMIC_INDICATORS) {
    const lookbackDays = definition.incrementalLookbackDays ?? (
      definition.frequency === "月频"
        ? 400
        : definition.frequency === "季频"
          ? 800
          : 14
    );
    const groupKey = `${lookbackDays}:${choiceEdbCodeFamily(definition.code)}`;
    const group = definitionsByRequestGroup.get(groupKey) ?? {
      lookbackDays,
      definitions: [],
    };
    group.definitions.push(definition);
    definitionsByRequestGroup.set(groupKey, group);
  }

  return [...definitionsByRequestGroup.values()]
    .sort((left, right) => left.lookbackDays - right.lookbackDays)
    .flatMap(({ lookbackDays, definitions }) =>
      chunkChoiceDefinitions(definitions, 8).map((chunk) => ({
        definitions: chunk,
        startDate: daysBefore(endDate, lookbackDays),
      })),
    );
}

function choiceEdbCodeFamily(code: string): string {
  // Choice rejects a single EDB request that mixes E* domestic rate series
  // with EM* macro/market series, even when both use the same lookback window.
  if (/^E\d/.test(code)) return "domestic-rate";
  if (/^EM[A-Z]\d/.test(code)) return "macro-market";
  return code.match(/^[A-Z]+/)?.[0] ?? code;
}

function chunkChoiceDefinitions(
  definitions: EconomicIndicatorDefinition[],
  size: number,
): EconomicIndicatorDefinition[][] {
  const chunks: EconomicIndicatorDefinition[][] = [];
  for (let offset = 0; offset < definitions.length; offset += size) {
    chunks.push(definitions.slice(offset, offset + size));
  }
  return chunks;
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Choice response field ${field} is invalid`);
  }
  return value;
}

function numericField(row: Record<string, unknown>, field: string): number {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`Choice response field ${field} is invalid`);
  }
  return value;
}

function choicePublishedDate(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return null;
}

function seriesPeriodKey(code: string, observationDate: string): string {
  return `${code}:${observationDate}`;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function shanghaiDate(value: Date): string {
  const shanghai = new Date(value.getTime() + 8 * 60 * 60 * 1_000);
  return shanghai.toISOString().slice(0, 10);
}

const MAX_DM_FULL_HISTORY_PAGES = 200;
