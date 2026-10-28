import type { DatabaseClient } from "./postgres.ts";
import { DASHBOARD_ECONOMIC_INDICATORS } from "../trading-research/economic-indicators.ts";

export type EconomicIndicatorDatabaseRow = {
  code: string;
  date: string;
  value: number;
};

export type EconomicIndicatorDatabaseResponse = {
  asOf: string;
  syncedAt: string;
  rows: EconomicIndicatorDatabaseRow[];
};

export class EconomicIndicatorDatabaseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EconomicIndicatorDatabaseError";
    this.status = status;
  }
}

export async function loadEconomicIndicators(
  client: DatabaseClient,
): Promise<EconomicIndicatorDatabaseResponse> {
  const result = await client.query<EconomicIndicatorQueryRow>(
    `SELECT
       indicator_code AS code,
       to_char(published_date, 'YYYY-MM-DD') AS date,
       value::double precision AS value,
       to_char(synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS synced_at
     FROM public.edb
     WHERE indicator_code = ANY($1::text[])
       AND published_date >= date_trunc('month', current_date - interval '18 months')::date
     ORDER BY indicator_code, observation_date`,
    [DASHBOARD_ECONOMIC_INDICATORS.map((indicator) => indicator.code)],
  );
  if (!result.rowCount) {
    throw new EconomicIndicatorDatabaseError(404, "暂无经济指标数据");
  }
  return {
    asOf: result.rows.reduce(
      (latest, row) => (row.date > latest ? row.date : latest),
      result.rows[0]!.date,
    ),
    syncedAt: result.rows.reduce(
      (latest, row) => (row.synced_at > latest ? row.synced_at : latest),
      result.rows[0]!.synced_at,
    ),
    rows: result.rows.map(({ code, date, value }) => ({ code, date, value })),
  };
}

type EconomicIndicatorQueryRow = EconomicIndicatorDatabaseRow & {
  synced_at: string;
};
