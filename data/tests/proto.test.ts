import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  decodeApiBinaryResponse,
  decodeCfetsCapitalHistoryList,
  decodeCfetsCapitalTableList,
} from "../src/dm/proto";

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
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

function fieldVarint(number: number, value: bigint): Uint8Array {
  return concat(varint(BigInt(number << 3)), varint(value));
}

function fieldBytes(number: number, value: Uint8Array): Uint8Array {
  return concat(varint(BigInt((number << 3) | 2)), varint(BigInt(value.length)), value);
}

function fieldString(number: number, value: string): Uint8Array {
  return fieldBytes(number, new TextEncoder().encode(value));
}

function fieldDouble(number: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat(varint(BigInt((number << 3) | 1)), bytes);
}

describe("DM protobuf decoder", () => {
  it("inflates the DM envelope and preserves int64 JSON compatibility", async () => {
    const cfetsRow = concat(
      fieldVarint(1, 1_788_000_000_000n),
      fieldVarint(2, 9_007_199_254_740_993n),
      fieldString(3, "DR001"),
      fieldDouble(4, 1.5234),
      fieldDouble(18, 1.51),
    );
    const cfetsList = fieldBytes(1, cfetsRow);
    const envelope = concat(
      fieldVarint(1, 0n),
      fieldString(2, "success"),
      fieldBytes(3, cfetsList),
    );
    const compressed = new Uint8Array(deflateSync(envelope));

    const api = await decodeApiBinaryResponse(compressed);
    const decoded = decodeCfetsCapitalTableList(api.data);

    expect(api.code).toBe(0);
    expect(api.message).toBe("success");
    expect(decoded.cfetsCapitalTable).toEqual([{
      issueTime: "1788000000000",
      flowId: "9007199254740993",
      bondCode: "DR001",
      weightedYield: 1.5234,
      weightedAvgRate: 1.51,
    }]);
  });

  it("rejects a truncated protobuf payload", () => {
    expect(() => decodeCfetsCapitalTableList(Uint8Array.from([0x0a, 0x05, 0x08])))
      .toThrow("truncated protobuf payload");
  });

  it("decodes the native CFETS history page and preserves its cursor fields", () => {
    const historyRow = concat(
      fieldVarint(1, 1_788_000_000_100n),
      fieldVarint(2, 9_007_199_254_740_993n),
      fieldString(3, "DR001"),
      fieldDouble(4, 1.5234),
      fieldDouble(5, 1.5),
      fieldDouble(6, 1.53),
      fieldDouble(7, 1.49),
      fieldDouble(8, 1.52),
      fieldDouble(9, 123_456),
      fieldString(10, "DR001"),
      fieldVarint(11, 1_763_308_799_000n),
      fieldDouble(12, 1.51),
      fieldDouble(23, -0.25),
    );
    const historyPage = concat(
      fieldVarint(1, 1n),
      fieldBytes(2, historyRow),
    );

    expect(decodeCfetsCapitalHistoryList(historyPage)).toEqual({
      hasNextPage: true,
      cfetsCapitalHistory: [{
        issueTime: "1788000000100",
        flowId: "9007199254740993",
        bondCode: "DR001",
        weightedYield: 1.5234,
        openYield: 1.5,
        highYield: 1.53,
        lowYield: 1.49,
        closeYield: 1.52,
        tradeAmount: 123_456,
        bondShortName: "DR001",
        capitalTime: "1763308799000",
        weightedAvgRate: 1.51,
        weightedYieldUpDownValueBp: -0.25,
      }],
    });
  });
});
