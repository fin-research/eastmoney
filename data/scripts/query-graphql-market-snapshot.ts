import {
  BOND_INFOS_QUERY,
  MARKET_CALENDAR_QUERY,
  MARKET_SNAPSHOT_QUERY,
  dateOffset,
  previousTradingDate,
  referencedBondCodes,
} from "./graphql-market-snapshot-query";

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string; path?: Array<string | number> }>;
}

const endpoint = process.env.DATA_GRAPHQL_URL
  ?? "https://eastmoney.hasbai.xyz/data/graphql";
const reportDate = process.argv[2] ?? new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const calendar = await request(MARKET_CALENDAR_QUERY, { date: reportDate });
const primaryStart = previousTradingDate(calendar.data?.tradingDays, reportDate);
const snapshot = await request(MARKET_SNAPSHOT_QUERY, {
  date: reportDate,
  omoStart: dateOffset(reportDate, -35),
  primaryStart,
});
const codes = referencedBondCodes(
  snapshot.data?.todayTrades,
  snapshot.data?.favoriteQuotes,
);
const bondInfos = codes.length
  ? await request(BOND_INFOS_QUERY, { codes: codes.join(",") })
  : { data: { bondInfos: [] } };
const data = { ...snapshot.data, bondInfos: bondInfos.data?.bondInfos ?? null };

console.log(JSON.stringify({
  endpoint,
  reportDate,
  previousTradingDate: primaryStart,
  fields: Object.keys(data),
  counts: Object.fromEntries(
    Object.entries(data).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.length : value == null ? null : 1,
    ]),
  ),
  errors: [...(snapshot.errors ?? []), ...(bondInfos.errors ?? [])],
  samples: Object.fromEntries(
    Object.entries(data).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.slice(0, 1) : value,
    ]),
  ),
}, null, 2));

async function request(
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json() as GraphqlResponse;
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}
