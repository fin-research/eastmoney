import type { QueryResultRow } from "pg";

import {
  buildBondLedgerAnalytics,
  emptyBondLedgerReport,
  toBondLedgerReport,
} from "../bond-ledger/analytics.ts";
import type {
  BondLedgerReport,
  BondLedgerSource,
  LedgerAccountDailySummary,
  LedgerPerformanceRow,
  LedgerPositionRow,
  LedgerTransaction,
  ParsedBondLedger,
} from "../bond-ledger/types";
import type { BondDatabaseClient } from "./postgres";
import { bondLedgerObjectKey } from "./bond-ledger.ts";

export type LedgerUploadStatus =
  | "processing"
  | "succeeded"
  | "failed"
  | "superseded"
  | "deleted";

export interface PersistBondLedgerInput {
  uploadId: string;
  /** Historical column retained for old imports; direct imports use a local audit identifier. */
  workflowInstanceId?: string;
  r2Key: string;
  r2Etag: string | null;
  originalName: string;
  fileSize: number;
  expectedDate: string | null;
  uploadedAt: string;
  parsed: ParsedBondLedger;
}

export interface PersistBondLedgerResult {
  reportDate: string;
  statisticsCount: number;
  positionCount: number;
  transactionCount: number;
}

export interface FailedBondLedgerInput {
  uploadId: string;
  /** Historical column retained for old imports; direct imports use a local audit identifier. */
  workflowInstanceId?: string;
  r2Key: string;
  r2Etag: string | null;
  originalName: string;
  fileSize: number;
  expectedDate: string | null;
  uploadedAt: string;
  errorMessage: string;
}

export interface RemoteBondLedgerFile {
  date: string;
  fileName: string;
  key: string;
  size: number;
  etag: string;
  uploadedAt: string;
}

export interface BondLedgerInventoryResponse {
  files: RemoteBondLedgerFile[];
  databaseDates: string[];
  availableStartDate: string | null;
  availableEndDate: string | null;
}

export class BondLedgerDatabaseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BondLedgerDatabaseError";
    this.status = status;
  }
}

export async function persistParsedBondLedger(
  client: BondDatabaseClient,
  input: PersistBondLedgerInput,
): Promise<PersistBondLedgerResult> {
  const { parsed } = input;
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('bond.ledger_import', 0))",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [parsed.date],
    );
    const existing = await client.query<ImportCountRow>(
      `SELECT
         to_char(report_date, 'YYYY-MM-DD') AS report_date,
         statistics_count,
         position_count,
         transaction_count,
         status
       FROM bond.ledger_upload
       WHERE id = $1::uuid OR r2_key = $2
       ORDER BY (status = 'succeeded') DESC
       LIMIT 1`,
      [input.uploadId, input.r2Key],
    );
    const existingRow = existing.rows[0];
    if (existingRow?.status === "succeeded" && existingRow.report_date) {
      await client.query("COMMIT");
      return importCountResult(existingRow);
    }

    await client.query(
      `INSERT INTO bond.ledger_upload (
         id, workflow_instance_id, r2_key, r2_etag, original_name,
         file_size, expected_date, report_date, status, uploaded_at,
         started_at, updated_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7::date, $8::date,
         'processing', $9::timestamptz, now(), now()
       )
       ON CONFLICT (id) DO UPDATE SET
         workflow_instance_id = EXCLUDED.workflow_instance_id,
         r2_key = EXCLUDED.r2_key,
         r2_etag = EXCLUDED.r2_etag,
         original_name = EXCLUDED.original_name,
         file_size = EXCLUDED.file_size,
         expected_date = EXCLUDED.expected_date,
         report_date = EXCLUDED.report_date,
         status = 'processing',
         error_message = NULL,
         started_at = COALESCE(bond.ledger_upload.started_at, now()),
         completed_at = NULL,
         updated_at = now()`,
      [
        input.uploadId,
        input.workflowInstanceId ?? `direct-${input.uploadId}`,
        input.r2Key,
        input.r2Etag,
        input.originalName,
        input.fileSize,
        input.expectedDate,
        parsed.date,
        input.uploadedAt,
      ],
    );

    await client.query(
      `UPDATE bond.ledger_upload
       SET status = 'superseded', updated_at = now()
       WHERE report_date = $1::date
         AND status = 'succeeded'
         AND id <> $2::uuid`,
      [parsed.date, input.uploadId],
    );

    await client.query(
      "DELETE FROM bond.daily_position WHERE report_date = $1::date",
      [parsed.date],
    );
    await insertPositions(client, input.uploadId, parsed.positions);
    const latestStatisticsSource = await client.query<{
      latest_source_date: string | null;
    }>(
      "SELECT max(source_report_date)::text AS latest_source_date FROM bond.daily_statistics",
    );
    const latestSourceDate =
      latestStatisticsSource.rows[0]?.latest_source_date ?? null;
    if (!latestSourceDate || parsed.date >= latestSourceDate) {
      await client.query(
        `DELETE FROM bond.daily_statistics
         WHERE NOT (stat_date = ANY($1::date[]))`,
        [parsed.performance.map((row) => row.date)],
      );
    }
    await upsertStatistics(
      client,
      input.uploadId,
      parsed.date,
      parsed.performance,
    );
    await client.query(
      `INSERT INTO bond.transaction_record (
         report_date, position_row_number, side, code, name, category,
         quantity, face_amount, realized_profit, source_upload_id
       )
       SELECT
         position.report_date,
         position.row_number,
         movement.side,
         position.code,
         position.name,
         position.category,
         movement.quantity,
         movement.quantity * 100,
         CASE WHEN movement.side = '买入' THEN NULL ELSE position.realized_profit END,
         $2::uuid
       FROM bond.daily_position AS position
       CROSS JOIN LATERAL (
         VALUES
           ('买入'::text, position.buy_quantity),
           ('卖出'::text, position.sell_quantity),
           ('到期'::text, position.maturity_quantity)
       ) AS movement(side, quantity)
       WHERE position.report_date = $1::date
         AND movement.quantity > 0`,
      [parsed.date, input.uploadId],
    );
    const transactionCount = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM bond.transaction_record
       WHERE report_date = $1::date`,
      [parsed.date],
    );
    const result: PersistBondLedgerResult = {
      reportDate: parsed.date,
      statisticsCount: parsed.performance.length,
      positionCount: parsed.positions.length,
      transactionCount: transactionCount.rows[0]?.count ?? 0,
    };
    await client.query(
      `UPDATE bond.ledger_upload
       SET status = 'succeeded',
           statistics_count = $2,
           position_count = $3,
           transaction_count = $4,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        input.uploadId,
        result.statisticsCount,
        result.positionCount,
        result.transactionCount,
      ],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function recordFailedBondLedgerImport(
  client: BondDatabaseClient,
  input: FailedBondLedgerInput,
): Promise<void> {
  await client.query(
    `INSERT INTO bond.ledger_upload (
       id, workflow_instance_id, r2_key, r2_etag, original_name,
       file_size, expected_date, status, error_message, uploaded_at,
       started_at, completed_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7::date, 'failed', $8,
       $9::timestamptz, now(), now(), now()
     )
     ON CONFLICT (id) DO UPDATE SET
       status = CASE
         WHEN bond.ledger_upload.status = 'succeeded' THEN 'succeeded'
         ELSE 'failed'
       END,
       error_message = CASE
         WHEN bond.ledger_upload.status = 'succeeded' THEN NULL
         ELSE EXCLUDED.error_message
       END,
       completed_at = now(),
       updated_at = now()`,
    [
      input.uploadId,
      input.workflowInstanceId ?? `direct-${input.uploadId}`,
      input.r2Key,
      input.r2Etag,
      input.originalName,
      input.fileSize,
      input.expectedDate,
      input.errorMessage.slice(0, 1000),
      input.uploadedAt,
    ],
  );
}

export async function listBondLedgerInventory(
  client: BondDatabaseClient,
): Promise<BondLedgerInventoryResponse> {
  const filesResult = await client.query<InventoryRow>(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS date,
       original_name AS file_name,
       r2_key,
       file_size,
       COALESCE(r2_etag, '') AS r2_etag,
       to_char(uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS uploaded_at
     FROM bond.ledger_upload
     WHERE status = 'succeeded'
     ORDER BY report_date`,
  );
  const databaseDatesResult = await client.query<{ date: string }>(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS date
     FROM bond.daily_position
     GROUP BY report_date
     ORDER BY report_date`,
  );
  const files = filesResult.rows.map((row) => ({
    date: row.date,
    fileName: row.file_name,
    key: row.r2_key.startsWith("bond-ledger/imports/") ? row.r2_key : bondLedgerObjectKey(row.date),
    size: toFiniteNumber(row.file_size),
    etag: row.r2_etag,
    uploadedAt: row.uploaded_at,
  }));
  const databaseDates = databaseDatesResult.rows.map((row) => row.date);
  return {
    files,
    databaseDates,
    availableStartDate: databaseDates.at(0) ?? null,
    availableEndDate: databaseDates.at(-1) ?? null,
  };
}

export async function findBondLedgerFile(
  client: BondDatabaseClient,
  date: string,
): Promise<RemoteBondLedgerFile> {
  const result = await client.query<InventoryRow>(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS date,
       original_name AS file_name,
       r2_key,
       file_size,
       COALESCE(r2_etag, '') AS r2_etag,
       to_char(uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS uploaded_at
     FROM bond.ledger_upload
     WHERE report_date = $1::date AND status = 'succeeded'`,
    [date],
  );
  const row = result.rows[0];
  if (!row) throw new BondLedgerDatabaseError(404, `${date} 台账不存在`);
  return {
    date: row.date,
    fileName: row.file_name,
    key: row.r2_key.startsWith("bond-ledger/imports/") ? row.r2_key : bondLedgerObjectKey(row.date),
    size: toFiniteNumber(row.file_size),
    etag: row.r2_etag,
    uploadedAt: row.uploaded_at,
  };
}

export async function deleteBondLedgerDate(
  client: BondDatabaseClient,
  date: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('bond.ledger_import', 0))",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [date],
    );
    const updated = await client.query(
      `UPDATE bond.ledger_upload
       SET status = 'deleted', updated_at = now()
       WHERE report_date = $1::date AND status = 'succeeded'
       RETURNING id`,
      [date],
    );
    if (!updated.rowCount) {
      throw new BondLedgerDatabaseError(404, `${date} 台账不存在`);
    }
    await client.query(
      "DELETE FROM bond.daily_statistics WHERE stat_date = $1::date",
      [date],
    );
    await client.query(
      "DELETE FROM bond.daily_position WHERE report_date = $1::date",
      [date],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function loadBondLedgerReport(
  client: BondDatabaseClient,
  startDate: string,
  endDate: string,
): Promise<BondLedgerReport> {
  const comparisonStartDate = shiftDate(startDate, -7);
  const historyStartDate = `${startDate.slice(0, 4)}-01-01`;
  const ledgerDatesResult = await client.query<{ date: string }>(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS date
     FROM bond.ledger_upload
     WHERE status = 'succeeded'
       AND report_date BETWEEN $1::date AND $2::date
     ORDER BY report_date`,
    [comparisonStartDate, endDate],
  );
  const ledgerDates = ledgerDatesResult.rows.map((row) => row.date);
  const latestDate = ledgerDates
    .filter((date) => date >= startDate && date <= endDate)
    .at(-1);
  if (!latestDate) return emptyBondLedgerReport();

  const performanceResult = await client.query<PerformanceRow>(
    `SELECT
       to_char(stat_date, 'YYYY-MM-DD') AS date,
       principal::double precision,
       time_weighted_principal::double precision,
       market_value::double precision,
       leverage::double precision,
       modified_duration::double precision,
       daily_revenue::double precision,
       cumulative_profit::double precision,
       ytd_annualized_return::double precision,
       ytd_ex_tax_annualized_return::double precision
     FROM bond.daily_statistics
     WHERE stat_date BETWEEN date_trunc('year', $2::date)::date AND $1::date
     ORDER BY stat_date`,
    [latestDate, startDate],
  );
  const positionsResult = await client.query<PositionRow>(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS report_date,
       row_number,
       team,
       investment_manager,
       account,
       code,
       market,
       name,
       category,
       yield_change_bp::double precision,
       remaining_years::double precision,
       to_char(interest_start_date, 'YYYY-MM-DD') AS interest_start_date,
       to_char(maturity_date, 'YYYY-MM-DD') AS maturity_date,
       current_quantity::double precision,
       pledged_quantity::double precision,
       available_quantity::double precision,
       previous_quantity::double precision,
       buy_quantity::double precision,
       sell_quantity::double precision,
       maturity_quantity::double precision,
       coupon_rate::double precision,
       valuation_yield::double precision,
       report_yield::double precision,
       full_price::double precision,
       dv01::double precision,
       market_value::double precision,
       coupon_income::double precision,
       tax_exempt_income::double precision,
       realized_profit::double precision,
       daily_profit::double precision,
       ytd_profit::double precision,
       full_price_cost::double precision
     FROM bond.daily_position
     WHERE report_date BETWEEN $1::date AND $2::date
     ORDER BY report_date, row_number`,
    [comparisonStartDate, endDate],
  );
  const accountTrendResult = await client.query<AccountTrendRow>(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS date,
       account,
       sum(market_value)::double precision AS market_value,
       sum(daily_profit)::double precision AS daily_profit,
       sum(tax_exempt_income)::double precision AS tax_exempt_income,
       sum(dv01)::double precision AS dv01,
       CASE
         WHEN sum(market_value) FILTER (WHERE market_value > 0) > 0
         THEN (
           sum(COALESCE(report_yield, 0) * market_value) FILTER (
             WHERE market_value > 0
           ) /
           sum(market_value) FILTER (WHERE market_value > 0)
         )::double precision
         ELSE NULL
       END AS weighted_report_yield,
       COALESCE(
         sum(market_value) FILTER (WHERE market_value > 0),
         0
       )::double precision AS report_yield_weight
     FROM bond.daily_position
     WHERE report_date BETWEEN $1::date AND $2::date
     GROUP BY report_date, account
     ORDER BY report_date, account`,
    [historyStartDate, endDate],
  );
  const transactionsResult = await client.query<TransactionRow>(
    `SELECT
       to_char(report_date, 'YYYY-MM-DD') AS date,
       side,
       code,
       name,
       category,
       quantity::double precision,
       face_amount::double precision,
       realized_profit::double precision
     FROM bond.transaction_record
     WHERE report_date BETWEEN $1::date AND $2::date
     ORDER BY report_date DESC, face_amount DESC`,
    [comparisonStartDate, endDate],
  );
  const performance = performanceResult.rows.map(performanceFromRow);
  const positions = positionsResult.rows.map(positionFromRow);
  const transactions = transactionsResult.rows.map(transactionFromRow);
  const accountDailySummaries = accountTrendResult.rows.map(
    accountTrendFromRow,
  );
  const positionsByDate = new Map<string, LedgerPositionRow[]>();
  for (const position of positions) {
    const rows = positionsByDate.get(position.reportDate) ?? [];
    rows.push(position);
    positionsByDate.set(position.reportDate, rows);
  }
  const sources: BondLedgerSource[] = ledgerDates.map((date) => ({
    date,
    performance,
    positions: positionsByDate.get(date) ?? [],
  }));
  return toBondLedgerReport(
    buildBondLedgerAnalytics(
      sources,
      startDate,
      endDate,
      transactions,
      accountDailySummaries,
    ),
  );
}

async function insertPositions(
  client: BondDatabaseClient,
  uploadId: string,
  positions: LedgerPositionRow[],
): Promise<void> {
  await client.query(
    `INSERT INTO bond.daily_position (
       report_date, row_number, team, investment_manager, account,
       code, market, name, category, yield_change_bp, remaining_years,
       interest_start_date, maturity_date, current_quantity, pledged_quantity,
       available_quantity, previous_quantity,
       buy_quantity, sell_quantity, maturity_quantity, coupon_rate,
       valuation_yield, report_yield, full_price, dv01, market_value,
       coupon_income, tax_exempt_income, realized_profit, daily_profit,
       ytd_profit, full_price_cost, source_upload_id, updated_at
     )
     SELECT
       source.report_date::date,
       source.row_number,
       source.team,
       source.investment_manager,
       source.account,
       source.code,
       source.market,
       source.name,
       source.category,
       source.yield_change_bp,
       source.remaining_years,
       source.interest_start_date::date,
       source.maturity_date::date,
       source.current_quantity,
       source.pledged_quantity,
       source.available_quantity,
       source.previous_quantity,
       source.buy_quantity,
       source.sell_quantity,
       source.maturity_quantity,
       source.coupon_rate,
       source.valuation_yield,
       source.report_yield,
       source.full_price,
       source.dv01,
       source.market_value,
       source.coupon_income,
       source.tax_exempt_income,
       source.realized_profit,
       source.daily_profit,
       source.ytd_profit,
       source.full_price_cost,
       $2::uuid,
       now()
     FROM jsonb_to_recordset($1::jsonb) AS source(
       report_date text,
       row_number integer,
       team text,
       investment_manager text,
       account text,
       code text,
       market text,
       name text,
       category text,
       yield_change_bp numeric,
       remaining_years numeric,
       interest_start_date text,
       maturity_date text,
       current_quantity numeric,
       pledged_quantity numeric,
       available_quantity numeric,
       previous_quantity numeric,
       buy_quantity numeric,
       sell_quantity numeric,
       maturity_quantity numeric,
       coupon_rate numeric,
       valuation_yield numeric,
       report_yield numeric,
       full_price numeric,
       dv01 numeric,
       market_value numeric,
       coupon_income numeric,
       tax_exempt_income numeric,
       realized_profit numeric,
       daily_profit numeric,
       ytd_profit numeric,
       full_price_cost numeric
     )`,
    [JSON.stringify(positions.map(positionToDatabase)), uploadId],
  );
}

async function upsertStatistics(
  client: BondDatabaseClient,
  uploadId: string,
  sourceReportDate: string,
  performance: LedgerPerformanceRow[],
): Promise<void> {
  await client.query(
    `INSERT INTO bond.daily_statistics (
       stat_date, principal, time_weighted_principal, market_value, leverage,
       modified_duration, daily_revenue, cumulative_profit,
       ytd_annualized_return, ytd_ex_tax_annualized_return,
       source_report_date, source_upload_id, updated_at
     )
     SELECT
       source.date::date,
       source.principal,
       source.time_weighted_principal,
       source.market_value,
       source.leverage,
       source.modified_duration,
       source.daily_revenue,
       source.cumulative_profit,
       source.ytd_annualized_return,
       source.ytd_ex_tax_annualized_return,
       $2::date,
       $3::uuid,
       now()
     FROM jsonb_to_recordset($1::jsonb) AS source(
       date text,
       principal numeric,
       time_weighted_principal numeric,
       market_value numeric,
       leverage numeric,
       modified_duration numeric,
       daily_revenue numeric,
       cumulative_profit numeric,
       ytd_annualized_return numeric,
       ytd_ex_tax_annualized_return numeric
     )
     ON CONFLICT (stat_date) DO UPDATE SET
       principal = EXCLUDED.principal,
       time_weighted_principal = EXCLUDED.time_weighted_principal,
       market_value = EXCLUDED.market_value,
       leverage = EXCLUDED.leverage,
       modified_duration = EXCLUDED.modified_duration,
       daily_revenue = EXCLUDED.daily_revenue,
       cumulative_profit = EXCLUDED.cumulative_profit,
       ytd_annualized_return = EXCLUDED.ytd_annualized_return,
       ytd_ex_tax_annualized_return = EXCLUDED.ytd_ex_tax_annualized_return,
       source_report_date = EXCLUDED.source_report_date,
       source_upload_id = EXCLUDED.source_upload_id,
       updated_at = now()
     WHERE EXCLUDED.source_report_date >= bond.daily_statistics.source_report_date`,
    [
      JSON.stringify(performance.map(performanceToDatabase)),
      sourceReportDate,
      uploadId,
    ],
  );
}

function performanceToDatabase(row: LedgerPerformanceRow) {
  return {
    date: row.date,
    principal: row.principal,
    time_weighted_principal: row.timeWeightedPrincipal,
    market_value: row.marketValue,
    leverage: row.leverage,
    modified_duration: row.modifiedDuration,
    daily_revenue: row.dailyRevenue,
    cumulative_profit: row.cumulativeProfit,
    ytd_annualized_return: row.ytdAnnualizedReturn,
    ytd_ex_tax_annualized_return: row.ytdExTaxAnnualizedReturn,
  };
}

function positionToDatabase(row: LedgerPositionRow) {
  return {
    report_date: row.reportDate,
    row_number: row.rowNumber,
    team: row.team,
    investment_manager: row.investmentManager,
    account: row.account,
    code: row.code,
    market: row.market,
    name: row.name,
    category: row.category,
    yield_change_bp: row.yieldChangeBp,
    remaining_years: row.remainingYears,
    interest_start_date: row.interestStartDate,
    maturity_date: row.maturityDate,
    current_quantity: row.currentQuantity,
    pledged_quantity: row.pledgedQuantity ?? null,
    available_quantity: row.availableQuantity ?? null,
    previous_quantity: row.previousQuantity,
    buy_quantity: row.buyQuantity,
    sell_quantity: row.sellQuantity,
    maturity_quantity: row.maturityQuantity,
    coupon_rate: row.couponRate,
    valuation_yield: row.valuationYield,
    report_yield: row.reportYield,
    full_price: row.fullPrice,
    dv01: row.dv01,
    market_value: row.marketValue,
    coupon_income: row.couponIncome,
    tax_exempt_income: row.taxExemptIncome,
    realized_profit: row.realizedProfit,
    daily_profit: row.dailyProfit,
    ytd_profit: row.ytdProfit,
    full_price_cost: row.fullPriceCost,
  };
}

interface ImportCountRow extends QueryResultRow {
  report_date: string | null;
  statistics_count: number;
  position_count: number;
  transaction_count: number;
  status: LedgerUploadStatus;
}

interface InventoryRow extends QueryResultRow {
  date: string;
  file_name: string;
  r2_key: string;
  file_size: string | number;
  r2_etag: string;
  uploaded_at: string;
}

interface PerformanceRow extends QueryResultRow {
  date: string;
  principal: number;
  time_weighted_principal: number;
  market_value: number;
  leverage: number;
  modified_duration: number;
  daily_revenue: number;
  cumulative_profit: number;
  ytd_annualized_return: number | null;
  ytd_ex_tax_annualized_return: number | null;
}

interface PositionRow extends QueryResultRow {
  report_date: string;
  row_number: number;
  team: string;
  investment_manager: string;
  account: string;
  code: string;
  market: string;
  name: string;
  category: string;
  yield_change_bp: number | null;
  remaining_years: number | null;
  interest_start_date: string | null;
  maturity_date: string | null;
  current_quantity: number;
  pledged_quantity: number | null;
  available_quantity: number | null;
  previous_quantity: number;
  buy_quantity: number;
  sell_quantity: number;
  maturity_quantity: number;
  coupon_rate: number | null;
  valuation_yield: number | null;
  report_yield: number | null;
  full_price: number | null;
  dv01: number;
  market_value: number;
  coupon_income: number;
  tax_exempt_income: number;
  realized_profit: number | null;
  daily_profit: number;
  ytd_profit: number;
  full_price_cost: number;
}

interface TransactionRow extends QueryResultRow {
  date: string;
  side: LedgerTransaction["side"];
  code: string;
  name: string;
  category: string;
  quantity: number;
  face_amount: number;
  realized_profit: number | null;
}

interface AccountTrendRow extends QueryResultRow {
  date: string;
  account: string;
  market_value: number;
  daily_profit: number;
  tax_exempt_income: number;
  dv01: number;
  weighted_report_yield: number | null;
  report_yield_weight: number;
}

function importCountResult(row: ImportCountRow): PersistBondLedgerResult {
  return {
    reportDate: row.report_date as string,
    statisticsCount: toFiniteNumber(row.statistics_count),
    positionCount: toFiniteNumber(row.position_count),
    transactionCount: toFiniteNumber(row.transaction_count),
  };
}

function performanceFromRow(row: PerformanceRow): LedgerPerformanceRow {
  return {
    date: row.date,
    principal: toFiniteNumber(row.principal),
    timeWeightedPrincipal: toFiniteNumber(row.time_weighted_principal),
    marketValue: toFiniteNumber(row.market_value),
    leverage: toFiniteNumber(row.leverage),
    modifiedDuration: toFiniteNumber(row.modified_duration),
    dailyRevenue: toFiniteNumber(row.daily_revenue),
    cumulativeProfit: toFiniteNumber(row.cumulative_profit),
    ytdAnnualizedReturn: toNullableNumber(row.ytd_annualized_return),
    ytdExTaxAnnualizedReturn: toNullableNumber(
      row.ytd_ex_tax_annualized_return,
    ),
  };
}

function positionFromRow(row: PositionRow): LedgerPositionRow {
  return {
    reportDate: row.report_date,
    rowNumber: toFiniteNumber(row.row_number),
    team: row.team,
    investmentManager: row.investment_manager,
    account: row.account,
    code: row.code,
    market: row.market,
    name: row.name,
    category: row.category,
    yieldChangeBp: toNullableNumber(row.yield_change_bp),
    remainingYears: toNullableNumber(row.remaining_years),
    interestStartDate: row.interest_start_date,
    maturityDate: row.maturity_date,
    currentQuantity: toFiniteNumber(row.current_quantity),
    pledgedQuantity: toNullableNumber(row.pledged_quantity),
    availableQuantity: toNullableNumber(row.available_quantity),
    previousQuantity: toFiniteNumber(row.previous_quantity),
    buyQuantity: toFiniteNumber(row.buy_quantity),
    sellQuantity: toFiniteNumber(row.sell_quantity),
    maturityQuantity: toFiniteNumber(row.maturity_quantity),
    couponRate: toNullableNumber(row.coupon_rate),
    valuationYield: toNullableNumber(row.valuation_yield),
    reportYield: toNullableNumber(row.report_yield),
    fullPrice: toNullableNumber(row.full_price),
    dv01: toFiniteNumber(row.dv01),
    marketValue: toFiniteNumber(row.market_value),
    couponIncome: toFiniteNumber(row.coupon_income),
    taxExemptIncome: toFiniteNumber(row.tax_exempt_income),
    realizedProfit: toNullableNumber(row.realized_profit),
    dailyProfit: toFiniteNumber(row.daily_profit),
    ytdProfit: toFiniteNumber(row.ytd_profit),
    fullPriceCost: toFiniteNumber(row.full_price_cost),
  };
}

function transactionFromRow(row: TransactionRow): LedgerTransaction {
  return {
    date: row.date,
    side: row.side,
    code: row.code,
    name: row.name,
    category: row.category,
    quantity: toFiniteNumber(row.quantity),
    faceAmount: toFiniteNumber(row.face_amount),
    realizedProfit: toNullableNumber(row.realized_profit),
  };
}

function accountTrendFromRow(
  row: AccountTrendRow,
): LedgerAccountDailySummary {
  return {
    date: row.date,
    account: row.account,
    marketValue: toFiniteNumber(row.market_value),
    dailyProfit: toFiniteNumber(row.daily_profit),
    taxExemptIncome: toFiniteNumber(row.tax_exempt_income),
    dv01: toFiniteNumber(row.dv01),
    weightedReportYield: toNullableNumber(row.weighted_report_yield),
    reportYieldWeight: toFiniteNumber(row.report_yield_weight),
  };
}

function toFiniteNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shiftDate(value: string, offset: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
