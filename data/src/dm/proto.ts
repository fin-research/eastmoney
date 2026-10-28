import { ApiError } from "../http";
import { redactDiagnosticText } from "../upstream-diagnostics";

type ScalarType =
  | "bool"
  | "double"
  | "int32"
  | "int64"
  | "uint32"
  | "string"
  | "bytes";

interface ScalarField {
  name: string;
  type: ScalarType;
}

interface MessageField {
  name: string;
  type: "message";
  schema: Schema;
  repeated?: boolean;
}

type Field = ScalarField | MessageField;
type Schema = Readonly<Record<number, Field>>;

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count += 1) {
      if (this.offset >= this.bytes.length) throw new Error("truncated protobuf varint");
      const byte = this.bytes[this.offset++];
      if (byte === undefined) throw new Error("truncated protobuf varint");
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("invalid protobuf varint");
  }

  double(): number {
    this.ensure(8);
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    ).getFloat64(0, true);
    this.offset += 8;
    return value;
  }

  fixed32(): void {
    this.ensure(4);
    this.offset += 4;
  }

  fixed64(): void {
    this.ensure(8);
    this.offset += 8;
  }

  lengthDelimited(): Uint8Array {
    const length = Number(this.varint());
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("invalid protobuf length");
    }
    this.ensure(length);
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.varint();
    } else if (wireType === 1) {
      this.fixed64();
    } else if (wireType === 2) {
      this.lengthDelimited();
    } else if (wireType === 5) {
      this.fixed32();
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }

  private ensure(length: number): void {
    if (this.offset + length > this.bytes.length) {
      throw new Error("truncated protobuf payload");
    }
  }
}

const decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function decodeMessage(bytes: Uint8Array, schema: Schema): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const result: Record<string, unknown> = {};
  while (!reader.done) {
    const tag = Number(reader.varint());
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    const field = schema[fieldNumber];
    if (!field) {
      reader.skip(wireType);
      continue;
    }

    let value: unknown;
    if (field.type === "message") {
      if (wireType !== 2) throw new Error("invalid protobuf message wire type");
      value = decodeMessage(reader.lengthDelimited(), field.schema);
    } else if (field.type === "double") {
      if (wireType !== 1) throw new Error("invalid protobuf double wire type");
      value = reader.double();
    } else if (field.type === "string") {
      if (wireType !== 2) throw new Error("invalid protobuf string wire type");
      value = decoder.decode(reader.lengthDelimited());
    } else if (field.type === "bytes") {
      if (wireType !== 2) throw new Error("invalid protobuf bytes wire type");
      value = reader.lengthDelimited();
    } else {
      if (wireType !== 0) throw new Error("invalid protobuf integer wire type");
      const raw = reader.varint();
      if (field.type === "bool") {
        value = raw !== 0n;
      } else if (field.type === "int64") {
        value = BigInt.asIntN(64, raw).toString();
      } else if (field.type === "int32") {
        value = Number(BigInt.asIntN(32, raw));
      } else {
        value = Number(BigInt.asUintN(32, raw));
      }
    }

    if (field.type === "message" && field.repeated) {
      const existing = result[field.name];
      const values = Array.isArray(existing) ? existing : [];
      values.push(value);
      result[field.name] = values;
    } else {
      result[field.name] = value;
    }
  }
  return result;
}

function fields(
  definitions: ReadonlyArray<readonly [string, number, ScalarType]>,
): Schema {
  return Object.fromEntries(
    definitions.map(([name, number, type]) => [number, { name, type }]),
  );
}

const API_RESPONSE: Schema = {
  1: { name: "code", type: "int32" },
  2: { name: "message", type: "string" },
  3: { name: "data", type: "bytes" },
};

const CFETS_ROW = fields([
  ["issueTime", 1, "int64"],
  ["flowId", 2, "int64"],
  ["bondCode", 3, "string"],
  ["weightedYield", 4, "double"],
  ["weightedYieldUpDownValueBp", 5, "double"],
  ["lastPrice", 6, "double"],
  ["upDownValueBp", 7, "double"],
  ["openYield", 8, "double"],
  ["highYield", 9, "double"],
  ["lowYield", 10, "double"],
  ["preWeightedYield", 11, "double"],
  ["tradeAmount", 12, "double"],
  ["bondShortName", 13, "string"],
  ["closeYield", 14, "double"],
  ["preClosePrice", 15, "double"],
  ["sortNo", 16, "int32"],
  ["repurchaseSource", 17, "int32"],
  ["weightedAvgRate", 18, "double"],
  ["avgRepurchaseTenor", 19, "double"],
  ["tradingNum", 20, "int64"],
  ["preWeightedAvgRate", 21, "double"],
  ["yieldMa5", 22, "double"],
  ["yieldMa10", 23, "double"],
  ["yieldMa20", 24, "double"],
  ["yieldMa60", 25, "double"],
  ["yieldMa120", 26, "double"],
  ["yieldMa250", 27, "double"],
]);

const CFETS_HISTORY_ROW = fields([
  ["issueTime", 1, "int64"],
  ["flowId", 2, "int64"],
  ["bondCode", 3, "string"],
  ["weightedYield", 4, "double"],
  ["openYield", 5, "double"],
  ["highYield", 6, "double"],
  ["lowYield", 7, "double"],
  ["closeYield", 8, "double"],
  ["tradeAmount", 9, "double"],
  ["bondShortName", 10, "string"],
  ["capitalTime", 11, "int64"],
  ["weightedAvgRate", 12, "double"],
  ["yieldMa5", 13, "double"],
  ["yieldMa10", 14, "double"],
  ["yieldMa20", 15, "double"],
  ["yieldMa60", 16, "double"],
  ["yieldMa120", 17, "double"],
  ["yieldMa250", 18, "double"],
  ["preClosePrice", 19, "double"],
  ["lastPrice", 20, "double"],
  ["upDownValueBp", 21, "double"],
  ["preWeightedYield", 22, "double"],
  ["weightedYieldUpDownValueBp", 23, "double"],
  ["preWeightedAvgRate", 24, "double"],
]);

const FUTURES_ROW = fields([
  ["contractCode", 1, "string"],
  ["contractTenorType", 2, "int32"],
  ["bidPrice1", 3, "double"],
  ["bidVolume1", 4, "double"],
  ["ofrPrice1", 5, "double"],
  ["ofrVolume1", 6, "double"],
  ["curVolume", 7, "double"],
  ["waPrice", 8, "double"],
  ["lastPrice", 10, "double"],
  ["highestPrice", 11, "double"],
  ["lowestPrice", 12, "double"],
  ["openInterest", 13, "double"],
  ["openPrice", 14, "double"],
  ["preSettlementPrice", 15, "double"],
  ["upDownValue", 16, "double"],
  ["upDownValuePct", 17, "double"],
  ["estimateSettlementPrice", 18, "double"],
  ["futuresContractSort", 19, "int32"],
  ["flowId", 20, "int64"],
  ["issueTime", 21, "int64"],
  ["contractType", 22, "uint32"],
  ["contractName", 23, "string"],
  ["diffInterestTotal", 24, "double"],
]);

const TODAY_TRADE = fields([
  ["dataId", 1, "string"],
  ["brokerType", 2, "int32"],
  ["flowId", 3, "string"],
  ["tradeId", 4, "int64"],
  ["bondUniCode", 5, "int64"],
  ["comUniCode", 6, "int64"],
  ["remainingTenor", 7, "string"],
  ["remainingTenorDay", 8, "int32"],
  ["maturityDate", 9, "int64"],
  ["ndStatus", 10, "int32"],
  ["cbYtm", 26, "double"],
  ["cbYte", 27, "double"],
  ["tradeYield", 35, "double"],
  ["tradeNetPrice", 36, "double"],
  ["priceStatus", 37, "int32"],
  ["exerciseHint", 38, "string"],
  ["tradeYieldSubCb", 40, "double"],
]);

const TODAY_TRADE_STAT = fields([
  ["dataId", 1, "string"],
  ["bondUniCode", 2, "int64"],
  ["tradeId", 3, "int64"],
  ["latestTradeYield", 4, "double"],
  ["highestTradeYield", 5, "double"],
  ["lowestTradeYield", 6, "double"],
]);

const TODAY_TRADE_ITEM: Schema = {
  1: { name: "trade", type: "message", schema: TODAY_TRADE },
  2: { name: "stat", type: "message", schema: TODAY_TRADE_STAT },
};

const FAVORITE_QUOTE = fields([
  ["dataId", 2, "string"], ["messageId", 3, "string"],
  ["bondUniCode", 4, "int64"], ["brokerType", 5, "uint32"],
  ["comUniCode", 6, "int64"], ["remainingTenor", 7, "string"],
  ["remainingTenorDay", 8, "int32"], ["maturityDate", 9, "int64"],
  ["maturityHolidayDay", 10, "uint32"], ["latestCouponRate", 11, "double"],
  ["bondBalance", 12, "double"], ["twoSideStatus", 13, "uint32"],
  ["bidEntryPrice", 14, "double"], ["bidEntryPriceStr", 15, "string"],
  ["bidPriceType", 16, "uint32"], ["bidYield", 17, "double"],
  ["bidNetPrice", 18, "double"], ["bidInstructionStatus", 19, "uint32"],
  ["bidSubscriptStatus", 20, "int32"], ["bidLiquidationSpeed", 21, "uint32"],
  ["bidVolumeStr", 22, "string"], ["bidVolumeValue", 23, "double"],
  ["bidHint", 24, "string"], ["ofrEntryPrice", 28, "double"],
  ["ofrEntryPriceStr", 29, "string"], ["ofrPriceType", 30, "uint32"],
  ["ofrYield", 31, "double"], ["ofrNetPrice", 32, "double"],
  ["ofrInstructionStatus", 33, "uint32"], ["ofrSubscriptStatus", 34, "int32"],
  ["ofrLiquidationSpeed", 35, "uint32"], ["ofrVolumeStr", 36, "string"],
  ["ofrVolumeValue", 37, "double"], ["ofrHint", 38, "string"],
  ["cbYield", 42, "double"], ["cbYtm", 43, "double"],
  ["cbYte", 44, "double"], ["cbNetPrice", 45, "double"],
  ["modifiedDuration", 46, "double"], ["bidYieldSubCb", 47, "double"],
  ["cbYieldSubOfr", 48, "double"], ["tradeYieldSubCb", 49, "double"],
  ["csYield", 50, "double"], ["csYtm", 51, "double"],
  ["csYte", 52, "double"], ["bidYieldSubCs", 53, "double"],
  ["csYieldSubOfr", 54, "double"], ["bidYieldSubOfr", 55, "double"],
  ["issueTime", 56, "int64"], ["issueDate", 57, "int64"],
  ["deleted", 58, "int32"], ["flowId", 59, "int64"],
  ["lastCloseYield", 60, "double"], ["tradeYieldSubClose", 61, "double"],
  ["tradeEntryPrice", 62, "double"], ["tradeIssueTime", 63, "int64"],
  ["tradeYieldSubCs", 64, "double"], ["bidIssueTime", 65, "int64"],
  ["ofrIssueTime", 66, "int64"], ["bidBrokerType", 67, "uint32"],
  ["ofrBrokerType", 68, "uint32"], ["ytdCloseYield", 69, "double"],
  ["tradeYieldSubYtdClose", 70, "double"], ["maturityDateCalendar", 71, "int64"],
  ["nonBankMaturityHolidayDay", 72, "uint32"], ["issueDateSubListDate", 73, "uint32"],
  ["fiveDaysNum", 74, "uint32"], ["bidBestSumVolume", 89, "double"],
  ["ofrBestSumVolume", 90, "double"], ["bidYieldType", 91, "uint32"],
  ["ofrYieldType", 92, "uint32"], ["seqNum", 93, "int64"],
  ["ofrSubCbYield", 94, "double"], ["bondShortName", 102, "string"],
  ["bondCode", 103, "string"],
]);

const CFETS_LIST: Schema = {
  1: { name: "cfetsCapitalTable", type: "message", schema: CFETS_ROW, repeated: true },
};
const CFETS_HISTORY_LIST: Schema = {
  1: { name: "hasNextPage", type: "bool" },
  2: {
    name: "cfetsCapitalHistory",
    type: "message",
    schema: CFETS_HISTORY_ROW,
    repeated: true,
  },
};
const FUTURES_LIST: Schema = {
  1: {
    name: "futuresContractLatestTradeProtoList",
    type: "message",
    schema: FUTURES_ROW,
    repeated: true,
  },
};
const TODAY_TRADE_LIST: Schema = {
  1: { name: "list", type: "message", schema: TODAY_TRADE_ITEM, repeated: true },
};
const FAVORITE_QUOTE_LIST: Schema = {
  5: { name: "offset", type: "int32" },
  6: { name: "limit", type: "int32" },
  7: { name: "list", type: "message", schema: FAVORITE_QUOTE, repeated: true },
};

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  let format: "deflate" | "gzip" | undefined;
  if (bytes[0] === 0x78) format = "deflate";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) format = "gzip";
  if (!format) return bytes;
  const copied = bytes.slice();
  const stream = new Blob([copied.buffer]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeApiBinaryResponse(bytes: Uint8Array): Promise<{
  code: number;
  message: string;
  data: Uint8Array;
}> {
  const decoded = decodeMessage(await inflate(bytes), API_RESPONSE);
  if (typeof decoded.code === "number" && decoded.code !== 0 && decoded.code !== 200) {
    throw new ApiError(503, `DM 返回业务错误 (${decoded.code}): ${redactDiagnosticText(String(decoded.message ?? "")).slice(0, 1000)}`, {
      code: "UPSTREAM_API_ERROR", source: "DM", stage: "decode",
      upstreamCode: decoded.code, upstreamMessage: redactDiagnosticText(String(decoded.message ?? "")).slice(0, 1000),
    });
  }
  return {
    code: typeof decoded.code === "number" ? decoded.code : 0,
    message: typeof decoded.message === "string" ? decoded.message : "",
    data: decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(),
  };
}

export function decodeCfetsCapitalTableList(bytes: Uint8Array): {
  cfetsCapitalTable: Array<Record<string, unknown>>;
} {
  const decoded = decodeMessage(bytes, CFETS_LIST);
  const rows = recordArray(decoded.cfetsCapitalTable);
  return {
    cfetsCapitalTable: rows.map((row) => ({
      issueTime: "0",
      flowId: "0",
      bondCode: "",
      ...row,
    })),
  };
}

export function decodeCfetsCapitalHistoryList(bytes: Uint8Array): {
  hasNextPage: boolean;
  cfetsCapitalHistory: Array<Record<string, unknown>>;
} {
  const decoded = decodeMessage(bytes, CFETS_HISTORY_LIST);
  const rows = recordArray(decoded.cfetsCapitalHistory);
  return {
    hasNextPage: decoded.hasNextPage === true,
    cfetsCapitalHistory: rows.map((row) => ({
      issueTime: "0",
      flowId: "0",
      bondCode: "",
      bondShortName: "",
      ...row,
    })),
  };
}

export function decodeFuturesLatestTradeList(bytes: Uint8Array): {
  futuresContractLatestTradeProtoList: Array<Record<string, unknown>>;
} {
  const decoded = decodeMessage(bytes, FUTURES_LIST);
  return {
    futuresContractLatestTradeProtoList: recordArray(
      decoded.futuresContractLatestTradeProtoList,
    ),
  };
}

export function decodeTodayTradeList(bytes: Uint8Array): {
  list: Array<Record<string, unknown>>;
} {
  const decoded = decodeMessage(bytes, TODAY_TRADE_LIST);
  const items = recordArray(decoded.list);
  return {
    list: items.map((item) => {
      const trade = isRecord(item.trade) ? item.trade : {};
      const stat = isRecord(item.stat) ? item.stat : {};
      return Object.keys(stat).length > 0 ? { ...trade, stat } : trade;
    }),
  };
}

export function decodeFavoriteQuoteList(bytes: Uint8Array): {
  list: Array<Record<string, unknown>>;
} {
  const decoded = decodeMessage(bytes, FAVORITE_QUOTE_LIST);
  return {
    list: recordArray(decoded.list),
  };
}
