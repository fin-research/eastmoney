import { cpuUsage } from "node:process";

import { graphql } from "graphql";

import { fetchChoiceTable } from "../src/choice/client.ts";
import { handleRequest } from "../src/app.ts";
import {
  bondInfoSchema,
  cfetsHistorySchema,
  parseRows,
  projectRows,
} from "../src/contracts.ts";
import { fetchNewsSummaries } from "../src/dm/news.ts";
import {
  decodeCfetsCapitalHistoryList,
  decodeCfetsCapitalTableList,
} from "../src/dm/proto.ts";
import { getSchema } from "../src/graphql.ts";
import { internalPathname } from "../src/routing.ts";
import { MARKET_SNAPSHOT_QUERY } from "./graphql-market-snapshot-query.ts";
import {
  A_SHARE_INDICES,
  collectChoiceMarket,
  SW_LEVEL_ONE_INDUSTRIES,
} from "../src/services/industry.ts";

interface SampleResult {
  case: string;
  samples: number;
  unit: string;
  average_ms: number;
  p50_ms: number;
  p95_ms: number;
  maximum_ms: number;
  local_p95_over_10ms: boolean;
}

const choiceHeaders = {
  "Content-Type": "application/json",
  "X-Choice-Rpc-Version": "choice.rpc.v1",
};
const allowRateLimit: RateLimit = { limit: async () => ({ success: true }) };

function percentile(values: readonly number[], ratio: number): number {
  const index = Math.min(values.length - 1, Math.floor(values.length * ratio));
  return values[index] ?? 0;
}

async function sample(
  name: string,
  action: () => void | Promise<void>,
  options: { samples?: number; warmup?: number; divisor?: number; unit?: string } = {},
): Promise<SampleResult> {
  const count = options.samples ?? 100;
  const divisor = options.divisor ?? 1;
  for (let index = 0; index < (options.warmup ?? 5); index += 1) await action();
  const measurements: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = cpuUsage();
    await action();
    const used = cpuUsage(started);
    measurements.push((used.user + used.system) / 1000 / divisor);
  }
  measurements.sort((left, right) => left - right);
  const average = measurements.reduce((sum, value) => sum + value, 0) / measurements.length;
  const p95 = percentile(measurements, 0.95);
  return {
    case: name,
    samples: count,
    unit: options.unit ?? "request",
    average_ms: Number(average.toFixed(3)),
    p50_ms: Number(percentile(measurements, 0.5).toFixed(3)),
    p95_ms: Number(p95.toFixed(3)),
    maximum_ms: Number((measurements.at(-1) ?? 0).toFixed(3)),
    local_p95_over_10ms: p95 > 10,
  };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function varint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function bytesField(number: number, value: Uint8Array): Uint8Array {
  return concat(varint(BigInt((number << 3) | 2)), varint(BigInt(value.length)), value);
}

function stringField(number: number, value: string): Uint8Array {
  return bytesField(number, new TextEncoder().encode(value));
}

function intField(number: number, value: bigint): Uint8Array {
  return concat(varint(BigInt(number << 3)), varint(value));
}

function doubleField(number: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat(varint(BigInt((number << 3) | 1)), bytes);
}

function cfetsPayload(rows: number): Uint8Array {
  const encoded: Uint8Array[] = [];
  for (let index = 0; index < rows; index += 1) {
    const row = concat(
      intField(1, 1_788_000_000_000n + BigInt(index)),
      intField(2, BigInt(index)),
      stringField(3, index % 2 === 0 ? "DR001" : "R001"),
      doubleField(4, 1.5 + index / 100_000),
      doubleField(18, 1.49 + index / 100_000),
    );
    encoded.push(bytesField(1, row));
  }
  return concat(...encoded);
}

function cfetsHistoryPayload(rows: number): Uint8Array {
  const encoded: Uint8Array[] = [intField(1, 1n)];
  for (let index = 0; index < rows; index += 1) {
    const time = 1_788_000_000_000n - BigInt(index) * 86_400_000n;
    const row = concat(
      intField(1, time + 100n),
      intField(2, 9_007_199_254_740_993n + BigInt(index)),
      stringField(3, "DR007"),
      doubleField(4, 1.5 + index / 100_000),
      doubleField(5, 1.49),
      doubleField(6, 1.51),
      doubleField(7, 1.48),
      doubleField(8, 1.5),
      doubleField(9, 100_000 + index),
      stringField(10, "DR007"),
      intField(11, time),
      doubleField(12, 1.495),
      doubleField(23, -0.25),
    );
    encoded.push(bytesField(2, row));
  }
  return concat(...encoded);
}

function choiceRpc(body: string): Fetcher {
  return {
    fetch: async () => new Response(body, { headers: choiceHeaders }),
  } as unknown as Fetcher;
}

const industryBody = JSON.stringify({
  function: "CSD",
  fields: ["code", "date", "PCTCHANGE", "MV"],
  rows: SW_LEVEL_ONE_INDUSTRIES.map(([code], index) => ({
    code,
    date: "2026-08-28",
    PCTCHANGE: index / 10,
    MV: 1_000_000_000_000 - index,
  })),
});
const turnoverBody = JSON.stringify({
  function: "CSD",
  fields: ["code", "date", "AMOUNT"],
  rows: [
    { code: "800004.EI", date: "2026-08-27", AMOUNT: 2e12 },
    { code: "800004.EI", date: "2026-08-28", AMOUNT: 2.1e12 },
  ],
});
const equityBody = JSON.stringify({
  function: "CSD",
  fields: ["code", "date", "CLOSE", "PCTCHANGE"],
  rows: A_SHARE_INDICES.map(([code], index) => ({
    code,
    date: "2026-08-28",
    CLOSE: 3_000 + index,
    PCTCHANGE: index / 10,
  })),
});

function choiceMarketEnv(): Pick<Cloudflare.Env, "CHOICE_RPC" | "CHOICE_RPC_TOKEN" | "CHOICE_FAST_LIMIT" | "CHOICE_OTHER_LIMIT"> {
  let call = 0;
  return {
    CHOICE_RPC_TOKEN: "benchmark",
    CHOICE_FAST_LIMIT: allowRateLimit,
    CHOICE_OTHER_LIMIT: allowRateLimit,
    CHOICE_RPC: {
      fetch: async () => {
        const body = [industryBody, turnoverBody, equityBody][call % 3] ?? equityBody;
        call += 1;
        return new Response(body, { headers: choiceHeaders });
      },
    } as unknown as Fetcher,
  };
}

function rawNewsRows(count: number): Array<Record<string, unknown>> {
  const start = Date.parse("2026-08-28T15:00:00+08:00");
  return Array.from({ length: count }, (_, index) => ({
    sentimentId: `sentiment-${index}`,
    newsId: `news-${index}`,
    title: `新闻标题 ${index}`,
    issueTime: start - index * 60_000,
    newsImportance: 2,
    newsTagsDTOList: [{ newsThirdTagName: "债券" }],
  }));
}

function dmNewsEnv(mode: "pages" | "briefing"): Pick<Cloudflare.Env, "DM" | "DM_COOKIE" | "DM_LIMIT"> {
  const rows = rawNewsRows(mode === "pages" ? 100 : 50);
  let page = 0;
  return {
    DM_COOKIE: "device_id=benchmark",
    DM_LIMIT: allowRateLimit,
    DM: {
      fetch: async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/news/info")) {
          return Response.json({
            code: 0,
            data: {
              sentimentId: new URL(request.url).searchParams.get("sentimentId"),
              title: "detail",
              issueTime: Date.parse("2026-08-28T15:00:00+08:00"),
              content: "正文".repeat(1_000),
            },
          });
        }
        page += 1;
        return Response.json({
          code: 0,
          data: {
            list: rows,
            pageSize: rows.length,
            hasNextPage: mode === "pages",
            endPageId: `page-${page}`,
          },
        });
      },
    } as unknown as Fetcher,
  };
}

const paths = [
  "/health", "/config", "/openapi.json", "/docs", "/redoc", "/cfets",
  "/cfets-histories",
  "/bond-top-case", "/futures-latest", "/primary-issues",
  "/broker-bond-registrations", "/news", "/news/id",
  "/wechat-articles", "/choice/csd", "/choice/css", "/choice/ctr", "/choice/edb",
  "/choice/data-statistics", "/industry", "/stock-summary",
  "/omo", "/margin", "/today-trades", "/favorite-quotes", "/bond-infos",
  "/graphql",
];

const results: SampleResult[] = [];
results.push(await sample("route prefix classification", () => {
  for (const path of paths) internalPathname(`/data${path}`);
}, { samples: 1_000, divisor: paths.length, unit: "route" }));

const routeEnv: Cloudflare.Env = {
  EASTMONEY: {} as R2Bucket,
  HYPERDRIVE: {} as Hyperdrive,
  ECONOMIC_INDICATOR_SYNC: {} as Workflow,
  DM_FUNDING_SYNC: {} as Workflow,
  DM: choiceRpc("{}"),
  CHOICE_RPC: choiceRpc("{}"),
  CAMEL: choiceRpc("{}"),
  CHOICE_FAST_LIMIT: allowRateLimit,
  CHOICE_OTHER_LIMIT: allowRateLimit,
  DM_LIMIT: allowRateLimit,
  EASTMONEY_LIMIT: allowRateLimit,
  CHINAMONEY_LIMIT: allowRateLimit,
  CAMEL_LIMIT: allowRateLimit,
  CLOUDFLARE_ACCOUNT_ID: "5cecc63c78acf8f5473f8745f4244448",
  AI_GATEWAY_ID: "default",
  DM_COOKIE: "device_id=benchmark",
  CHOICE_RPC_TOKEN: "benchmark",
  CF_AIG_TOKEN: "benchmark",
  CAMEL_USERNAME: "benchmark",
  CAMEL_PASSWORD: "benchmark",
};
results.push(await sample("Hono health route dispatch", async () => {
  const response = await handleRequest(
    new Request("https://eastmoney.hasbai.xyz/data/health"),
    routeEnv,
  );
  if (response.status !== 200) throw new Error("health benchmark failed");
}, { samples: 1_000 }));

const bondTopCaseRows = Array.from({ length: 63 }, (_, index) => ({
  ordinateName: "国债",
  abscissaName: "10Y",
  bondCode: `${260000 + index}.IB`,
  tradeNum: index,
  yield: index === 62 ? null : 1.8,
  yieldSubYtdCloseBp: index === 62 ? null : -1,
}));
const bondTopCaseEnv = {
  ...routeEnv,
  DM: {
    fetch: async () => Response.json({ code: 0, data: bondTopCaseRows }),
  } as unknown as Fetcher,
};
results.push(await sample("bond top case DTO, 63 rows with a missing yield", async () => {
  const response = await handleRequest(new Request(
    "https://eastmoney.hasbai.xyz/data/bond-top-case?date=2026-09-09&fields=ordinateName,abscissaName,bondCode,tradeNum,yield,yieldSubYtdCloseBp",
  ), bondTopCaseEnv);
  if (response.status !== 200) throw new Error("bond top case benchmark failed");
  await response.arrayBuffer();
}, { samples: 100 }));

const brokerRegistrationRows = Array.from({ length: 50 }, (_, index) => ({
  projectFullName: `测试证券公司债券项目${index}`,
  comFullName: `测试证券股份有限公司${index}`,
  projectRegisterStatusText: "已受理",
  projectRegisterTypeText: "小公募",
  issueAmount: index + 1,
  provinceName: "上海",
  induLevel2Name: "证券",
  underwriterName: "测试承销商",
  regNoticeNumber: `上证函〔2026〕${index}号`,
  projectRegisterPlatform: 3,
  registerOrFiling: 1,
  updateDate: "2026-08-28 12:00:00",
}));
const brokerRegistrationEnv = {
  ...routeEnv,
  DM: {
    fetch: async () => Response.json({
      code: 0,
      data: { hasNextPage: false, list: brokerRegistrationRows },
    }),
  } as unknown as Fetcher,
};
results.push(await sample("broker bond registration DTO, 50 rows", async () => {
  const response = await handleRequest(new Request(
    "https://eastmoney.hasbai.xyz/data/broker-bond-registrations?startDate=2026-08-24&endDate=2026-08-28&pageSize=50&fields=projectName,issuerName,status,variety,amountYi,updateDate",
  ), brokerRegistrationEnv);
  if (response.status !== 200) throw new Error("broker registration benchmark failed");
  await response.arrayBuffer();
}, { samples: 100 }));

const choicePayload = JSON.stringify({
  function: "CSD",
  fields: ["code", "date", "CLOSE"],
  rows: Array.from({ length: 1_000 }, (_, index) => ({
    code: `${index.toString().padStart(6, "0")}.SH`,
    date: "2026-08-28",
    CLOSE: index / 10,
  })),
});
const choiceEnv = { CHOICE_RPC: choiceRpc(choicePayload), CHOICE_RPC_TOKEN: "benchmark", CHOICE_FAST_LIMIT: allowRateLimit, CHOICE_OTHER_LIMIT: allowRateLimit };
results.push(await sample("Choice shared DTO validation, 1000 rows", async () => {
  await fetchChoiceTable(choiceEnv, "csd", { codes: "000001.SH", indicators: "CLOSE" });
}, { samples: 200 }));

results.push(await sample("industry normalization, 31 industries", async () => {
  await collectChoiceMarket(choiceMarketEnv(), "2026-08-28");
}, { samples: 100 }));

const cfets = cfetsPayload(500);
results.push(await sample("DM protobuf decode, 500 rows", () => {
  decodeCfetsCapitalTableList(cfets);
}, { samples: 100 }));

const cfetsHistory = cfetsHistoryPayload(100);
results.push(await sample("CFETS history decode/project, 100 rows", () => {
  const page = decodeCfetsCapitalHistoryList(cfetsHistory);
  const rows = parseRows(
    cfetsHistorySchema,
    page.cfetsCapitalHistory,
    "CFETS 历史资金利率",
  );
  JSON.stringify(projectRows(
    cfetsHistorySchema,
    rows,
    "bondCode,capitalTime,weightedYield,weightedYieldUpDownValueBp",
  ));
}, { samples: 100 }));

const bondInfoRows = Array.from({ length: 100 }, (_, index) => ({
  bondUniCode: 1_000_000_000 + index,
  bondShortName: `26测试${index}`,
  comShortName: `测试证券${index}`,
  bondType: 37,
  bondOfferingType: 1,
  sciTechInnoBondStatus: index % 2,
  ...Object.fromEntries(
    Array.from({ length: 175 }, (_value, fieldIndex) => [
      `unusedField${fieldIndex}`,
      fieldIndex,
    ]),
  ),
}));
results.push(await sample("bond info DTO projection, 100 x 180 fields", () => {
  const rows = parseRows(bondInfoSchema, bondInfoRows, "债券基础信息");
  JSON.stringify(projectRows(
    bondInfoSchema,
    rows,
    "bondUniCode,bondShortName,comShortName,bondType,bondOfferingType",
  ));
}, { samples: 100 }));

const marketGraphqlPayload = {
  omo: Array.from({ length: 50 }, (_, index) => ({
    operationDate: "2026-09-04",
    operationName: "逆回购",
    duration: "7D",
    interestRate: 1.4,
    operationAmount: index * 10,
  })),
  dr: Array.from({ length: 4 }, (_, index) => ({
    bondCode: `DR00${index + 1}`,
    weightedYield: 1.4 + index / 100,
    weightedYieldUpDownValueBp: index - 2,
  })),
  dibo: Array.from({ length: 4 }, (_, index) => ({
    bondCode: `DIBO00${index + 1}`,
    weightedYield: 1.45 + index / 100,
    weightedYieldUpDownValueBp: 2 - index,
  })),
  governmentBonds: Array.from({ length: 62 }, (_, index) => ({
    ordinateName: "国债",
    abscissaName: `${index + 1}Y`,
    bondCode: `2600${index}`,
    tradeNum: index + 1,
    yield: 1.5 + index / 1_000,
    yieldSubYtdCloseBp: index / 10,
  })),
  futures: Array.from({ length: 16 }, (_, index) => ({
    contractCode: `T${index}`,
    lastPrice: 100 + index / 10,
    upDownValuePct: index / 100,
  })),
  stock: {
    title: "A股市场收评",
    time: "2026-09-04T15:30:00+08:00",
    paragraphs: ["市场收评段落".repeat(40), "行业表现段落".repeat(40)],
  },
  margin: Array.from({ length: 2 }, (_, index) => ({
    DIM_DATE: `2026-09-0${4 - index}`,
    TOTAL_RZRQYE: 2e12 - index * 1e9,
    TOTAL_RZYE: 1.99e12 - index * 1e9,
    TOTAL_RQYE: 1e10,
  })),
  industry: {
    dataDate: "2026-09-04",
    equities: A_SHARE_INDICES.map(([code], index) => ({
      name: code,
      close: 3_000 + index,
      change_pct: index / 10,
    })),
    industries: SW_LEVEL_ONE_INDUSTRIES.map(([code], index) => ({
      name: code,
      change_pct: index / 10,
      market_cap_yuan: 1e12 - index,
    })),
    turnoverYi: 21_000,
    turnoverChangeYi: 1_000,
    tradingDates: ["2026-09-03", "2026-09-04"],
  },
  primary: Array.from({ length: 50 }, (_, index) => ({
    bidStartDate: "2026-09-04",
    comShortName: `测试证券${index}`,
    bondShortName: `26测试${index}`,
    issueTenor: "3Y",
    planIssueAmount: index + 1,
    issueCouponRate: 1.8,
  })),
  todayTrades: Array.from({ length: 67 }, (_, index) => ({
    bondUniCode: String(1_000_000_000 + index),
    remainingTenor: "3Y",
    cbYte: 1.8,
    tradeYield: 1.81,
    tradeYieldSubCb: 1,
  })),
  favoriteQuotes: Array.from({ length: 35 }, (_, index) => ({
    bondUniCode: String(1_000_000_000 + index),
    bondShortName: `26测试${index}`,
    remainingTenor: "3Y",
    remainingTenorDay: 1_095,
    cbYield: 1.8,
    bidYield: 1.81,
    ofrYield: 1.82,
    tradeYieldSubCb: 1,
  })),
};
const marketGraphqlRoot = Object.fromEntries(
  Object.entries(marketGraphqlPayload).map(([name, value]) => [
    name,
    () => value,
  ]),
);

results.push(await sample("GraphQL market snapshot envelope", async () => {
  const result = await graphql({
    schema: getSchema(),
    source: MARKET_SNAPSHOT_QUERY,
    rootValue: marketGraphqlRoot,
    variableValues: {
      date: "2026-09-04",
      omoStart: "2026-08-01",
      primaryStart: "2026-09-03",
    },
  });
  JSON.stringify(result);
}, { samples: 100 }));

results.push(await sample("Avoided GraphQL REST-adapter JSON roundtrip", async () => {
  const decoded = await Promise.all(
    Object.values(marketGraphqlPayload).map((value) => Response.json(value).json()),
  );
  JSON.stringify(decoded);
}, { samples: 100 }));

results.push(await sample("DM news date scan, 20 x 100 rows", async () => {
  await fetchNewsSummaries(dmNewsEnv("pages"), {
    pageSize: 100,
    tag: "不存在的标签",
    startTime: Date.parse("2026-08-28T00:00:00+08:00"),
    endTime: Date.parse("2026-08-28T23:59:59+08:00"),
    maximumPages: 20,
  });
}, { samples: 30 }));

results.push(await sample("DM news detail batch, 10 bodies with 2000 chars each", async () => {
  const response = await handleRequest(new Request("https://data/news?date=2026-08-28&detail=true&pageSize=10&offset=30"), { ...routeEnv, ...dmNewsEnv("briefing") });
  if (response.status !== 200) throw new Error(await response.text());
  await response.arrayBuffer();
}, { samples: 30 }));

results.push(await sample("GraphQL parse and execute, metadata query", async () => {
  await graphql({ schema: getSchema(), source: "{ __typename }" });
}, { samples: 500 }));

console.log(JSON.stringify({
  runtime: process.version,
  warning: "Local Node CPU is a risk screen, not Cloudflare Trace cpuTime.",
  results,
}, null, 2));
