import { fetchChoiceTable } from "./client";
import {
  ApiError,
  jsonResponse,
  normalizeCsv,
  optionalDate,
  optionalParameter,
  parseDate,
  requiredParameter,
  requireMethod,
} from "../http";

type ChoiceEnv = Pick<Cloudflare.Env, "CHOICE_RPC" | "CHOICE_RPC_TOKEN" | "CHOICE_FAST_LIMIT" | "CHOICE_OTHER_LIMIT">;

function dateRange(parameters: URLSearchParams): {
  startDate: string;
  endDate: string;
} {
  const startDate = parseDate(requiredParameter(parameters, "startDate", 10), "startDate");
  const endDate = parseDate(requiredParameter(parameters, "endDate", 10), "endDate");
  if (startDate > endDate) {
    throw new ApiError(422, "startDate 不能晚于 endDate");
  }
  return { startDate, endDate };
}

export async function resolveChoiceData(
  request: Request,
  env: ChoiceEnv,
  pathname: string,
) {
  const parameters = new URL(request.url).searchParams;
  if (!pathname.startsWith("/choice/")) return null;
  requireMethod(request, "GET");

  if (pathname === "/choice/csd") {
    const { startDate, endDate } = dateRange(parameters);
    return fetchChoiceTable(env, "csd", {
      codes: normalizeCsv(requiredParameter(parameters, "codes", 4096), "codes"),
      indicators: normalizeCsv(
        requiredParameter(parameters, "indicators", 4096),
        "indicators",
        { maximumItems: 64 },
      ),
      startDate,
      endDate,
      options: optionalParameter(parameters, "options", 4096),
    });
  }
  if (pathname === "/choice/css") {
    return fetchChoiceTable(env, "css", {
      codes: normalizeCsv(requiredParameter(parameters, "codes", 4096), "codes"),
      indicators: normalizeCsv(
        requiredParameter(parameters, "indicators", 4096),
        "indicators",
        { maximumItems: 64 },
      ),
      options: optionalParameter(parameters, "options", 4096),
    });
  }
  if (pathname === "/choice/ctr") {
    return fetchChoiceTable(env, "ctr", {
      reportName: requiredParameter(parameters, "reportName", 256),
      indicators: normalizeCsv(
        optionalParameter(parameters, "indicators", 4096),
        "indicators",
        { required: false },
      ),
      options: optionalParameter(parameters, "options", 4096),
    });
  }
  if (pathname === "/choice/edb") {
    const { startDate, endDate } = dateRange(parameters);
    return fetchChoiceTable(env, "edb", {
      edbIds: normalizeCsv(
        requiredParameter(parameters, "edbIds", 4096),
        "edbIds",
        { maximumItems: 100 },
      ),
      startDate,
      endDate,
      options: optionalParameter(parameters, "options", 4096),
    });
  }
  if (pathname === "/choice/data-statistics") {
    const startDate = optionalDate(parameters, "startDate");
    const endDate = optionalDate(parameters, "endDate");
    if ((startDate === undefined) !== (endDate === undefined)) {
      throw new ApiError(422, "startDate 和 endDate 必须同时提供");
    }
    if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
      throw new ApiError(422, "startDate 不能晚于 endDate");
    }
    return fetchChoiceTable(env, "datastatistics", {
      funcName: optionalParameter(parameters, "funcName", 64),
      indicators: normalizeCsv(
        optionalParameter(parameters, "indicators", 4096),
        "indicators",
        { required: false, maximumItems: 32 },
      ),
      startDate,
      endDate,
      options: optionalParameter(parameters, "options", 4096),
    });
  }
  return null;
}

export async function handleChoiceRoute(
  request: Request,
  env: ChoiceEnv,
  pathname: string,
): Promise<Response | null> {
  const data = await resolveChoiceData(request, env, pathname);
  return data === null ? null : jsonResponse(data);
}
