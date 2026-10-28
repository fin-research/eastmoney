import { z } from "zod";

import { creditInstitutionUpdateSchema } from "$lib/credit/update.ts";
import { creditMaskedQuerySchema } from "$lib/credit/masked.ts";
import { loadCreditMasked } from "$lib/server/credit-masked.ts";
import { BondLedgerUploadError, validateSameOrigin } from "$lib/server/bond-ledger.ts";
import {
  CreditDatabaseError,
  loadCreditData,
  loadCreditUsage,
  saveCreditInstitution,
} from "$lib/server/credit-repository.ts";
import { withPostgres } from "$lib/server/postgres.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  const view = url.searchParams.get("view");
  if (view === 'masked' && (!creditMaskedQuerySchema.safeParse(Object.fromEntries(url.searchParams)).success ||
      new Set(url.searchParams.keys()).size !== [...url.searchParams].length))
    return Response.json({error:'授信查询参数无效'},{status:400,headers:{'Cache-Control':'no-store'}});
  const institution = url.searchParams.get("institution");
  const type = url.searchParams.get("type");
  const offset = url.searchParams.get("offset") ?? "0";
  if (view !== null && view !== 'usage' && view !== 'masked' || view === 'usage' && (!institution?.trim() || institution.length > 200 || !['bond_investment','yield_certificate','interbank_lending'].includes(type ?? '') || !/^\d+$/.test(offset) || Number(offset) > 100000))
    return Response.json({error:'授信用量参数无效'},{status:400,headers:{'Cache-Control':'no-store'}});
  const date = url.searchParams.get("date");
  const month = url.searchParams.get("month");
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return Response.json({error:"日历月份无效"},{status:400,headers:{"Cache-Control":"no-store"}});
  if (view === 'usage' && !date || date && !isIsoDate(date)) {
    return Response.json(
      { error: "报表日必须是有效的 YYYY-MM-DD 日期" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const report = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-credit-report",
      async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const report = view === 'masked' ? await loadCreditMasked(client,date ?? undefined,url.searchParams.get('institutionId') ?? undefined)
            : view === 'usage' ? await loadCreditUsage(client,date!,institution!,type as import('$lib/credit/types.ts').CreditUsageType,Number(offset)) : await loadCreditData(client, date, month ?? undefined);
          await client.query('COMMIT');
          return report;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      },
    );
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CreditDatabaseError) {
      return Response.json(
        { error: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("credit report query failed", error);
    return Response.json(
      { error: "授信数据暂时不可用" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};

export const PATCH: RequestHandler = async ({ platform, request, locals }) => {
  try {
    validateSameOrigin(request);
    if (!locals.user?.auth0Id) throw new CreditDatabaseError(401,"请先登录");
    const input = creditInstitutionUpdateSchema.parse(await request.json());
    if (request.method === "POST") {
      const fields = input.changes.institution;
      if (!fields?.institutionType || !fields.status || fields.confidentialityStatus == null) throw new CreditDatabaseError(400,"请填写机构性质、授信状态和保密协议状态");
    }
    const result = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-credit-update",
      (client) => saveCreditInstitution(client, input, locals.user!.auth0Id, request.method === "POST"),
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status =
      error instanceof BondLedgerUploadError || error instanceof CreditDatabaseError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 503;
    if (status >= 500) console.error("credit update failed", error);
    const message =
      error instanceof BondLedgerUploadError || error instanceof CreditDatabaseError
        ? error.message
        : status === 400
          ? `授信数据格式无效：${error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}：${issue.message}`).join("；") : "请求无效"}`
          : "授信数据保存失败，请稍后重试";
    return Response.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};

export const POST = PATCH;

function isIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}
