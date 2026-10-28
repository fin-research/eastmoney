import type { DatabaseClient } from "./postgres.ts";
export type EconomicIndicatorSyncRow = { code: string; date: string; observationDate: string; value: number };

export async function persistEconomicIndicators(
  client: DatabaseClient,
  rows: EconomicIndicatorSyncRow[],
  options: { replaceCodes?: readonly string[] } = {},
): Promise<{ rowCount: number; asOf: string }> {
  if (!rows.length) throw new Error("经济指标同步结果为空");
  for (const row of rows) {
    if (
      !row.code ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.observationDate) ||
      !Number.isFinite(row.value)
    ) {
      throw new Error("经济指标同步数据格式无效");
    }
  }

  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('public.edb.sync', 0))",
    );
    if (options.replaceCodes?.length) {
      const replaceCodes = [...new Set(options.replaceCodes)];
      await client.query(
        "DELETE FROM public.edb WHERE indicator_code = ANY($1::text[])",
        [replaceCodes],
      );
    }
    let rowCount = 0;
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
      const result = await client.query(
        `INSERT INTO public.edb (
         indicator_code, observation_date, published_date, value, synced_at
       )
       SELECT
         item.code,
         item."observationDate"::date,
         item.date::date,
         item.value::numeric,
         clock_timestamp()
       FROM jsonb_to_recordset($1::jsonb) AS item(
         code text,
         "observationDate" text,
         date text,
         value double precision
       )
       ON CONFLICT (indicator_code, observation_date)
       DO UPDATE SET
         published_date = EXCLUDED.published_date,
         value = EXCLUDED.value,
         synced_at = clock_timestamp()`,
        [JSON.stringify(batch)],
      );
      rowCount += result.rowCount ?? batch.length;
    }
    await client.query("COMMIT");
    return {
      rowCount,
      asOf: rows.reduce(
        (latest, row) => (row.date > latest ? row.date : latest),
        rows[0]!.date,
      ),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

const INSERT_BATCH_SIZE = 2_000;
