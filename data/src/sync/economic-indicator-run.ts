import type { DataResponseEvidence } from './css-response-evidence.ts';
import type { WorkflowStep } from "cloudflare:workers";
import {
  choiceRequestBatches, fetchDmFundingRateRows,
  normalizeChoiceEconomicIndicatorRows, parseChoiceEconomicIndicatorTable,
  type DataApiRequest, type ChoiceEconomicIndicatorRawRow,
  dmFundingRateCodeMap,
} from "./economic-indicator-sync.ts";
import type { EconomicIndicatorSyncRow } from "./economic-indicators-repository.ts";
import {
  EconomicIndicatorRequestError, economicIndicatorErrorDetails,
  redactEconomicIndicatorError,
} from "./economic-indicator-request.ts";

// limit counts retries AFTER the initial call: 3 attempts, delayed 1m then 2m.
export const ECONOMIC_INDICATOR_STEP_CONFIG = {
  retries: { limit: 2, delay: "1 minute", backoff: "exponential" as const },
  timeout: "2 minutes",
} as const;

export type RequestSpec = {
  id: string;
  source: "choice-edb" | "dm-funding-history";
  path: string;
  parameters: Record<string, string>;
  codes: string[];
};
type ArchiveFailure = { requestId: string; attempt: number; error: string };
type Failure = { step: string; request: RequestSpec; error: { name: string; message: string } };
type Fetched = { rawRows: ChoiceEconomicIndicatorRawRow[]; rows: EconomicIndicatorSyncRow[]; pageCount: number };
export type EconomicIndicatorGroupResult = {
  name: string;
  status: "complete" | "partial" | "failed";
  missing: Array<{ source: string; codes: string[] }>;
  requests: EconomicIndicatorSyncResult["requests"];
  archiveFailures?: ArchiveFailure[];
  archivedResponses?: number;
  failures: Failure[];
  rowCount: number;
  asOf: string;
  returnedCodes: string[];
  pageCount: number;
};

export type EconomicIndicatorSyncResult = {
  workflowInstanceId: string;
  scheduledTime: number;
  status: "complete" | "partial" | "failed";
  range: { startDate: string; endDate: string };
  requestedIndicators: number;
  returnedIndicators: number;
  dmPages: number;
  storedRows: number;
  asOf: string;
  requests: Array<{ id: string; source: string; codes: string[]; status: "complete" | "failed"; storedRows: number }>;
  archiveFailures: ArchiveFailure[];
  archivedResponses: number;
  failures: Failure[];
  groups: EconomicIndicatorGroupResult[];
};

export function economicIndicatorRequests(scheduledTime: number): RequestSpec[] {
  const endDate = new Date(scheduledTime + 8 * 3600_000).toISOString().slice(0, 10);
  const choice = choiceRequestBatches("incremental", endDate).map((batch, index): RequestSpec => {
    const codes = batch.definitions.map(({ code }) => code);
    return { id: `choice-${index + 1}`, source: "choice-edb", path: "/choice/edb", codes,
      parameters: { edbIds: codes.join(","), startDate: batch.startDate, endDate, options: "IsPublishDate=1,FixDate=0" } };
  });
  const dm = [...dmFundingRateCodeMap].map(([bondCode, code]): RequestSpec => ({
    id: `dm-${bondCode!}`, source: "dm-funding-history", path: "/cfets-histories", codes: [code!],
    parameters: { bondCode: bondCode!, endCapitalTime: String(scheduledTime), limit: "100",
      fields: "bondCode,capitalTime,weightedYield,lastPrice,weightedYieldUpDownValueBp" },
  }));
  return [...choice, ...dm];
}

export async function runEconomicIndicatorSync(
  step: Pick<WorkflowStep, "do">,
  workflowInstanceId: string,
  scheduledTime: number,
  request: DataApiRequest,
  persist: (rows: EconomicIndicatorSyncRow[]) => Promise<{ rowCount: number; asOf: string }>,
  options: {
    archive?: (spec: RequestSpec, attempt: number, evidence: DataResponseEvidence) => Promise<void>;
    choiceSettled?: () => void;
    dmOnly?: boolean;
    dmGroup?: () => Promise<EconomicIndicatorGroupResult>;
  } = {},
): Promise<EconomicIndicatorSyncResult> {
  const specs = economicIndicatorRequests(scheduledTime).filter(spec => !options.dmOnly || spec.source === 'dm-funding-history');
  const endDate = new Date(scheduledTime + 8 * 3600_000).toISOString().slice(0, 10);

  async function fetchSource(spec: RequestSpec, attempt: number, archiveFailures: ArchiveFailure[], archived: { count: number }): Promise<Fetched> {
    let payload: unknown;
    try {
      const capture = spec.source === 'choice-edb' && options.archive ? async (evidence: DataResponseEvidence) => {
        try { await options.archive!(spec, attempt, evidence); archived.count++; }
        catch {
          const failure = { requestId: spec.id, attempt, error: 'EDB response archive unavailable' };
          archiveFailures.push(failure);
          console.error(JSON.stringify({ event: 'edb_response_archive_failed', workflowInstanceId, ...failure }));
        }
      } : undefined;
      payload = await request(spec.path, new URLSearchParams(spec.parameters), capture);
      if (spec.source === "choice-edb") {
        return { rawRows: parseChoiceEconomicIndicatorTable(payload), rows: [], pageCount: 0 };
      }
      const dm = await fetchDmFundingRateRows(async () => payload, "incremental", new Date(scheduledTime), [spec.parameters.bondCode!]);
      return { rawRows: [], rows: dm.rows, pageCount: dm.pageCount };
    } catch (error) {
      if (payload === undefined) throw error;
      const body = redactEconomicIndicatorError(JSON.stringify(payload));
      throw new EconomicIndicatorRequestError({ path: spec.path, parameters: spec.parameters,
        stage: "response_validation", responseBody: body.slice(0, 24_000), responseTruncated: body.length > 24_000,
        cause: economicIndicatorErrorDetails(error) });
    }
  }

  async function syncGroup(name: string, group: RequestSpec[]): Promise<EconomicIndicatorGroupResult> {
    try {
      if (group[0]?.source === 'dm-funding-history' && options.dmGroup) return await options.dmGroup();
      return await step.do(name, ECONOMIC_INDICATOR_STEP_CONFIG, async (context) => {
        // Await every request, including on failure. The group is the retry boundary.
        const archiveFailures: ArchiveFailure[] = [];
        const archived = { count: 0 };
        const fetched = await Promise.allSettled(group.map(spec => fetchSource(spec, context.attempt, archiveFailures, archived)));
        const references = fetched.flatMap(result => result.status === "fulfilled" ? result.value.rawRows : []);
        const failures: Failure[] = [];
        const sources = group.map((spec, index) => {
          const result = fetched[index]!;
          try {
            if (result.status === "rejected") throw result.reason;
            const rows = spec.source === "choice-edb"
              ? normalizeChoiceEconomicIndicatorRows(result.value.rawRows, endDate, references)
              : result.value.rows;
            return { spec, rows, pageCount: result.value.pageCount, ok: true };
          } catch (error) {
            const failure = { step: name, request: spec, error: economicIndicatorErrorDetails(error) };
            failures.push(failure);
            console.error(JSON.stringify({ event: "economic_indicators_workflow_step_failed",
              workflowInstanceId, attempt: context.attempt, ...failure }));
            return { spec, rows: [], pageCount: 0, ok: false };
          }
        });
        // Retry the whole small group; on the last attempt retain successful sources
        // and durably return the unavailable sources as partial/failed diagnostics.
        if (failures.length && context.attempt <= ECONOMIC_INDICATOR_STEP_CONFIG.retries.limit) {
          throw new Error(JSON.stringify({ workflowInstanceId, step: name, failures }));
        }
        const rows = sources.flatMap(source => source.rows);
        const stored = rows.length ? await persist(rows) : { rowCount: 0, asOf: "" };
        const missing = sources.flatMap(source => {
          const codes = source.spec.codes.filter(code => !source.rows.some(row => row.code === code));
          return codes.length ? [{ source: source.spec.id, codes }] : [];
        });
        return { ...stored, name, status: failures.length === group.length ? "failed" : failures.length || archiveFailures.length ? "partial" : "complete", missing, failures, archiveFailures, archivedResponses: archived.count, returnedCodes: [...new Set(rows.map(row => row.code))],
          pageCount: sources.reduce((sum, source) => sum + source.pageCount, 0),
          requests: sources.map(({ spec, rows, ok }) => ({ id: spec.id, source: spec.source, codes: spec.codes,
            status: ok ? "complete" as const : "failed" as const, storedRows: rows.length })) };
      });
    } catch (error) {
      // A storage/runtime failure invalidates this group's result, not its siblings.
      return { name, status: "failed", missing: group.map(spec => ({ source: spec.id, codes: spec.codes })),
        rowCount: 0, asOf: "", returnedCodes: [], pageCount: 0,
        requests: group.map(spec => ({ id: spec.id, source: spec.source, codes: spec.codes,
          status: "failed", storedRows: 0 })),
        failures: group.map(spec => ({ step: name, request: spec, error: economicIndicatorErrorDetails(error) })) };
    }
  }

  const groups = await Promise.all([
    ...(!options.dmOnly ? [syncGroup("同步 Choice 经济指标", specs.filter(spec => spec.source === "choice-edb")).then(result => {
      options.choiceSettled?.();
      return result;
    })] : []),
    syncGroup("同步 DM 资金面", specs.filter(spec => spec.source === "dm-funding-history")),
  ]);
  const failures = groups.flatMap(group => group.failures);
  const archiveFailures = groups.flatMap(group => group.archiveFailures ?? []);
  return {
    workflowInstanceId, scheduledTime,
    status: failures.length === specs.length ? "failed" : failures.length || archiveFailures.length ? "partial" : "complete",
    range: { startDate: specs.flatMap(spec => spec.parameters.startDate ? [spec.parameters.startDate] : []).sort()[0] ?? endDate, endDate },
    requestedIndicators: specs.reduce((sum, spec) => sum + spec.codes.length, 0),
    returnedIndicators: new Set(groups.flatMap(group => group.returnedCodes)).size,
    dmPages: groups.reduce((sum, group) => sum + group.pageCount, 0),
    storedRows: groups.reduce((sum, group) => sum + group.rowCount, 0),
    asOf: groups.map(group => group.asOf).sort().at(-1) ?? "",
    requests: groups.flatMap(group => group.requests), failures, archiveFailures,
    archivedResponses: groups.reduce((sum, group) => sum + (group.archivedResponses ?? 0), 0), groups,
  };
}
