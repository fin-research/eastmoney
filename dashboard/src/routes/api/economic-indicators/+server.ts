import {
  EconomicIndicatorDatabaseError,
  loadEconomicIndicators,
} from "$lib/server/economic-indicators-repository.ts";
import { withPostgres } from "$lib/server/postgres.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform }) => {
  try {
    const result = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-economic-indicators",
      loadEconomicIndicators,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof EconomicIndicatorDatabaseError) {
      return Response.json(
        { error: error.message },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    console.error("economic indicator query failed", error);
    return Response.json(
      { error: "经济指标暂时不可用" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
