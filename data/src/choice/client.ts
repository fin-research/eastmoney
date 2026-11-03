import { z } from "zod";

import { ApiError } from "../http";
import { requireUpstreamCapacity } from "../upstream-rate-limit";
import { readUpstreamError, readUpstreamJson, redactDiagnosticText, responseDetails, UpstreamPayloadError } from "../upstream-diagnostics";

export const CHOICE_SESSION_ORIGIN = "https://choice.session.internal";
export const CHOICE_SESSION_VERSION = "choice.native.v1";

export interface ChoiceTable {
  function: "CSD" | "CSS" | "CTR" | "EDB" | "DATASTATISTICS" | "TRADEDATES";
  fields: string[];
  rows: Array<Record<string, unknown>>;
}

export const choiceTableSchema = z.object({
  function: z.enum(["CSD", "CSS", "CTR", "EDB", "DATASTATISTICS", "TRADEDATES"]),
  fields: z.array(z.string()),
  rows: z.preprocess((rows) => rows == null ? [] : Array.isArray(rows) ? rows.filter((row) => row !== null) : rows,
    z.array(z.record(z.string(), z.unknown()))),
});
interface ChoiceBindings {
  CHOICE_SESSION: DurableObjectNamespace;
  CHOICE_FAST_LIMIT: RateLimit;
  CHOICE_OTHER_LIMIT: RateLimit;
}

async function nativeResponse(
  env: Pick<Cloudflare.Env, keyof ChoiceBindings>,
  functionName: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const upstreamPath = `/query/${functionName}`;
  const fast = functionName === "csd" || functionName === "css";
  await requireUpstreamCapacity(
    fast ? env.CHOICE_FAST_LIMIT : env.CHOICE_OTHER_LIMIT,
    functionName,
    "Choice",
  );
  let response: Response;
  try {
    response = await env.CHOICE_SESSION.getByName("licensed-account").fetch(
      new Request(`${CHOICE_SESSION_ORIGIN}${upstreamPath}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      }),
    );
  } catch (error) {
    const cause = {
      name: error instanceof Error ? error.name : "Error",
      message: redactDiagnosticText(error instanceof Error ? error.message : String(error), []).slice(0, 1000),
    };
    throw new ApiError(cause.name === "TimeoutError" ? 504 : 503,
      `Choice native ${functionName} fetch failed: ${cause.message}`, {
        code: cause.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK_ERROR",
        source: "Choice native", stage: "fetch", upstreamPath, cause,
      });
  }
  if (!response.ok) {
    const upstreamResponse = await readUpstreamError(response, []);
    let detail = `Choice native ${functionName} returned HTTP ${response.status}`;
    let upstreamCode: string | number | undefined;
    try {
      const body: unknown = JSON.parse(upstreamResponse.body);
      const parsed = z.object({ error: z.object({ message: z.string().optional(), upstreamCode: z.number().int().optional(), code: z.union([z.string(), z.number()]).optional() }).optional() }).safeParse(body);
      if (parsed.success) {
        detail = parsed.data.error?.message ?? detail;
        upstreamCode = parsed.data.error?.upstreamCode ?? parsed.data.error?.code;
      }
    } catch { /* Non-JSON upstream responses remain available in upstreamResponse.body. */ }
    throw new ApiError(response.status === 429 ? 429 : response.status === 504 ? 504 : 503, detail, {
      code: "UPSTREAM_HTTP_ERROR",
      source: "Choice native",
      stage: "fetch",
      upstreamStatus: response.status,
      upstreamPath,
      upstreamResponse,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
  }
  const version = response.headers.get("X-Choice-Native-Version");
  if (version !== CHOICE_SESSION_VERSION) {
    throw new ApiError(503, "Choice native version mismatch", {
      code: "UPSTREAM_VERSION_MISMATCH",
      source: "Choice native",
      stage: "response_headers",
      upstreamStatus: response.status,
      upstreamPath,
    });
  }
  return response;
}

export async function fetchChoiceTable(
  env: Pick<Cloudflare.Env, keyof ChoiceBindings>,
  functionName: string,
  payload: Record<string, unknown>,
): Promise<ChoiceTable> {
  const response = await nativeResponse(env, functionName, payload);
  const secrets: string[] = [];
  let body: unknown;
  try { body = await readUpstreamJson(response, secrets); }
  catch (error) {
    throw new ApiError(503, `Choice native ${functionName} returned invalid JSON: ${redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets)}`, {
      code: "UPSTREAM_INVALID_JSON", source: "Choice native", stage: "decode",
      upstreamStatus: response.status, upstreamPath: `/query/${functionName}`,
      ...(error instanceof UpstreamPayloadError ? { upstreamResponse: error.details } : {}),
    });
  }
  const table = choiceTableSchema.safeParse(body);
  if (!table.success) {
    throw new ApiError(503, "Choice native returned an invalid table", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      source: "Choice native",
      stage: "response_validation",
      upstreamStatus: response.status,
      upstreamPath: `/query/${functionName}`,
      upstreamResponse: responseDetails(response, JSON.stringify(body), secrets),
      issues: table.error.issues.slice(0, 12).map((issue) => ({
        path: issue.path.join("."), code: issue.code, message: issue.message, receivedType: "invalid",
      })),
    });
  }
  return table.data;
}
