import {
  archiveBondLedgerRequest,
  BondLedgerUploadError,
  getBondLedgerFile,
  ledgerDownloadHeaders,
  validateLedgerDate,
  validateSameOrigin,
} from "$lib/server/bond-ledger";
import {
  BondLedgerDatabaseError,
  deleteBondLedgerDate,
  findBondLedgerFile,
  listBondLedgerInventory,
  loadBondLedgerReport,
  persistParsedBondLedger,
  recordFailedBondLedgerImport,
} from "$lib/server/bond-ledger-repository";
import { withPostgres } from "$lib/server/postgres";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  try {
    const startDate = url.searchParams.get("start");
    const endDate = url.searchParams.get("end");
    if (startDate || endDate) {
      if (!startDate || !endDate) {
        throw new BondLedgerUploadError(400, "统计范围必须同时包含起止日期");
      }
      validateLedgerDate(startDate);
      validateLedgerDate(endDate);
      if (startDate > endDate) {
        throw new BondLedgerUploadError(400, "统计起始日期不能晚于结束日期");
      }
      const report = await withPostgres(
        platform?.env.HYPERDRIVE?.connectionString,
        "eastmoney-bond-report",
        (client) => loadBondLedgerReport(client, startDate, endDate),
      );
      return Response.json(report, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const date = url.searchParams.get("date");
    if (date) {
      validateLedgerDate(date);
      const file = await withPostgres(
        platform?.env.HYPERDRIVE?.connectionString,
        "eastmoney-bond-download",
        (client) => findBondLedgerFile(client, date),
      );
      const object = await getBondLedgerFile(platform?.env.EASTMONEY, file);
      return new Response(object.body as BodyInit, {
        headers: ledgerDownloadHeaders(object, file.fileName),
      });
    }
    const inventory = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-bond-inventory",
      listBondLedgerInventory,
    );
    return Response.json(inventory, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, url, "read");
  }
};

export const POST: RequestHandler = async ({ request, platform, url }) => {
  try {
    const result = await archiveBondLedgerRequest(
      request,
      platform?.env.EASTMONEY,
      (input) => withPostgres(platform?.env.HYPERDRIVE?.connectionString, "eastmoney-bond-import",
        (client) => persistParsedBondLedger(client, input)),
      (input) => withPostgres(platform?.env.HYPERDRIVE?.connectionString, "eastmoney-bond-import-failure",
        (client) => recordFailedBondLedgerImport(client, input)),
    );
    return Response.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, url, "upload");
  }
};

export const DELETE: RequestHandler = async ({ request, platform, url }) => {
  try {
    const date = url.searchParams.get("date") ?? "";
    validateSameOrigin(request);
    validateLedgerDate(date);
    await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-bond-delete",
      (client) => deleteBondLedgerDate(client, date),
    );
    return Response.json(
      { deleted: true, date },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, url, "delete");
  }
};

function errorResponse(error: unknown, url: URL, action: string): Response {
  const status =
    error instanceof BondLedgerUploadError ||
    error instanceof BondLedgerDatabaseError
      ? error.status
      : 500;
  console.error(
    JSON.stringify({
      event: `bond_ledger_${action}_failed`,
      status,
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return Response.json(
    {
      error:
        error instanceof BondLedgerUploadError ||
        error instanceof BondLedgerDatabaseError
          ? error.message
          : "台账管理失败，请稍后重试",
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
