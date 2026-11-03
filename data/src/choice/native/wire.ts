/** Offline-recovered Choice Linux SDK wire primitives.
 * SDK sha256 267c87809fed6b0de68720da662e098d2db07432626eeb7cf3e8915f78e15e26.
 * These functions perform no I/O and do not establish login/session readiness.
 */
export class ChoiceWireError extends Error {
  constructor(message: string) { super(message); this.name = "ChoiceWireError"; }
}
export const REQUEST_HEADER_BYTES = 14;
export const RESPONSE_HEADER_BYTES = 13;
export const MAX_WIRE_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_ROWS = 100_000;
export const MAX_OUTPUT_CELLS = 1_000_000;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** cquantbusiness::makereqdata @0x25c4a0. */
export function encodeChoiceFrame(command: string): Uint8Array {
  const body = utf8.encode(command);
  if (body.byteLength > MAX_WIRE_BYTES - REQUEST_HEADER_BYTES) throw new ChoiceWireError("Choice request exceeds byte limit");
  const bytes = new Uint8Array(REQUEST_HEADER_BYTES + body.byteLength);
  new DataView(bytes.buffer).setUint32(1, bytes.byteLength, true);
  bytes[5] = 1; bytes[6] = 0xfa; bytes[13] = 5;
  bytes.set(body, REQUEST_HEADER_BYTES);
  return bytes;
}
export interface ChoiceResponseHeader { length: number; type: number; compression: number; }
/** _tagFrameRecvHead::copyFromData @0x2b4450; response type differs from request function. */
export function decodeChoiceHeader(bytes: Uint8Array): ChoiceResponseHeader {
  if (bytes.byteLength !== RESPONSE_HEADER_BYTES) throw new ChoiceWireError("Invalid Choice response header length");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
  if (length < RESPONSE_HEADER_BYTES || length > MAX_WIRE_BYTES) throw new ChoiceWireError("Invalid Choice response frame length");
  const compression = bytes[7]!;
  if (compression !== 0 && compression !== 2) throw new ChoiceWireError("Unsupported Choice compression");
  return { length, type: bytes[9]!, compression };
}

export class ChoiceReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  position = 0;
  constructor(bytes: Uint8Array) {
    if (bytes.byteLength > MAX_WIRE_BYTES) throw new ChoiceWireError("Choice payload exceeds byte limit");
    this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number { return this.bytes.byteLength - this.position; }
  take(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remaining) throw new ChoiceWireError("Truncated Choice payload");
    const result = this.bytes.subarray(this.position, this.position + count); this.position += count; return result;
  }
  u8(): number { return this.take(1)[0]!; }
  i16(): number { const p=this.position; this.take(2); return this.view.getInt16(p,true); }
  u16(): number { const p=this.position; this.take(2); return this.view.getUint16(p,true); }
  i32(): number { const p=this.position; this.take(4); return this.view.getInt32(p,true); }
  u32(): number { const p=this.position; this.take(4); return this.view.getUint32(p,true); }
  i64(): bigint { const p=this.position; this.take(8); return this.view.getBigInt64(p,true); }
  u64(): bigint { const p=this.position; this.take(8); return this.view.getBigUint64(p,true); }
  f32(): number { const p=this.position; this.take(4); return this.view.getFloat32(p,true); }
  f64(): number { const p=this.position; this.take(8); return this.view.getFloat64(p,true); }
  /** cquantstaticfunc::read7bitencodedint @0x263580; reject overflow/malformed input. */
  varint(): number {
    let value = 0;
    for (let index=0; index<5; index++) {
      const byte=this.u8();
      if (index === 4 && byte > 0x0f) throw new ChoiceWireError("Choice varint overflows uint32");
      value += (byte & 0x7f) * 2 ** (7 * index);
      if ((byte & 0x80) === 0) return value;
    }
    throw new ChoiceWireError("Unterminated Choice varint");
  }
  string(): string {
    const length=this.varint();
    try { return utf8Decoder.decode(this.take(length)); }
    catch (error) { if (error instanceof ChoiceWireError) throw error; throw new ChoiceWireError("Invalid Choice UTF-8"); }
  }
}

export type ChoiceScalar = string | number | boolean | bigint | null;
function finite(value: number, limit: number): number | null {
  return Number.isFinite(value) && value > -limit && value < limit ? value : null;
}
/** cquantstaticfunc::decodetoeqvariant @0x272080.
 * Wire DataType values are NOT the public EqVariant type enum.
 * Int64s remain bigint here; callers must choose an explicit JSON representation.
 */
export function decodeChoiceScalar(reader: ChoiceReader, wireType: number): ChoiceScalar {
  switch (wireType) {
    case 0: return reader.u8() !== 0;
    case 1: return reader.u8();
    case 3: return String.fromCharCode(reader.u8());
    case 4:
    case 12: { const value=reader.string(); return value.length ? value : null; }
    case 5: { const value=reader.string(); return value.length ? value.split(" ",1)[0]! : null; }
    case 6: {
      const lo=BigInt(reader.u32()), mid=BigInt(reader.u32()), hi=BigInt(reader.u32()), flags=reader.u32();
      const scale=(flags >>> 16) & 0xff;
      if ((flags & 0x7f00ffff) !== 0 || scale > 28) throw new ChoiceWireError("Invalid Choice decimal flags");
      const integer=lo | (mid << 32n) | (hi << 64n);
      const digits=integer.toString().padStart(scale + 1,"0");
      const text=scale ? digits.slice(0,-scale)+"."+digits.slice(-scale) : digits;
      return finite(Number((flags & 0x80000000 ? "-" : "")+text),7.922816251426434e28);
    }
    case 7: return finite(reader.f64(),1.79769e308);
    case 8: return finite(reader.f32(),3.402820018375656e38);
    case 9: { const v=reader.i32(); return v===-2147483648 || v===2147483647 ? null : v; }
    case 10: { const v=reader.i64(); return v===-9223372036854775808n || v===9223372036854775807n ? null : v; }
    case 11: { const v=reader.i16(); return v===-32768 || v===32767 ? null : v; }
    case 13: { const v=reader.u32(); return v===4294967295 ? null : v; }
    case 14: { const v=reader.u64(); return v===18446744073709551615n ? null : v; }
    case 15: { const v=reader.u16(); return v===65535 ? null : v; }
    case 16: reader.u8(); return null;
    default: throw new ChoiceWireError(`Unsupported Choice wire type ${wireType}`);
  }
}

function lineAtom(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new ChoiceWireError("Control character in Choice command");
  return value;
}
/** cquantstaticfunc::makecodescommand @0x2632f0. */
export function choiceCodesCommand(codes: readonly string[]): string {
  if (codes.some(code => /[,\r\n\0]/.test(code))) throw new ChoiceWireError("Invalid Choice code");
  return codes.length ? `$secucode=${codes.join(",")}\r\n` : "\r\n";
}
export interface ChoiceQueryCommand {
  codes: readonly string[];
  indicators: string;
  options: string;
  token: string;
  requestId: string;
}
/** After SDK-equivalent parameter/date normalization. SessionId is a request GUID. */
export function choiceCssCommand(query: ChoiceQueryCommand): string {
  return "$-api\r\n$name=em_css\r\n" + choiceCodesCommand(query.codes)
    + "$subfname=" + lineAtom(query.indicators) + "," + lineAtom(query.options)
    + ",token=" + lineAtom(query.token) + ",SessionId=" + lineAtom(query.requestId);
}
export function choiceCsdCommand(query: ChoiceQueryCommand & { startDate: string; endDate: string }): string {
  return "$-api\r\n$name=em_csd_2\r\n" + choiceCodesCommand(query.codes)
    + "$subfname=" + lineAtom(query.indicators) + ",StartDate=" + lineAtom(query.startDate)
    + ",EndDate=" + lineAtom(query.endDate) + "," + lineAtom(query.options)
    + ",token=" + lineAtom(query.token) + ",SessionId=" + lineAtom(query.requestId);
}
/** ctradedates::checkparams @0x27d880; caller resolves SDK date macros first. */
export function choiceTradeDatesCommand(query: { startDate: string; endDate: string; period: string; order: "1" | "2"; market: string }): string {
  return "$-rpt\r\n$name=Const_TradeDate\r\n$StartDate=" + lineAtom(query.startDate)
    + ",EndDate=" + lineAtom(query.endDate) + ",DataType=1,PERIOD=" + lineAtom(query.period)
    + ",DESC=" + (query.order === "1" ? "ESC" : "DESC") + ",TEXCH=" + lineAtom(query.market);
}

export interface ChoiceSheet {
  name: string;
  columns: string[];
  types: number[];
  rows: ChoiceScalar[][];
}
/** cquantstaticfunc::decodetozbtable @0x290df0, verified with the SDK pure decoder. */
export function decodeChoiceSheets(bytes: Uint8Array): ChoiceSheet[] {
  const reader = new ChoiceReader(bytes);
  reader.take(8); // Opaque dataset header retained by the SDK; not a row/column count.
  const sheets: ChoiceSheet[] = [];
  let cells = 0, rowCount = 0;
  while (reader.remaining) {
    if (sheets.length >= 1024) throw new ChoiceWireError("Choice sheet count exceeds limit");
    const length = reader.u64();
    if (length > BigInt(reader.remaining) || length === 0n) throw new ChoiceWireError("Invalid Choice sheet length");
    const sheet = new ChoiceReader(reader.take(Number(length)));
    const name = sheet.string();
    const metadataLength = sheet.i16();
    if (metadataLength <= 0) throw new ChoiceWireError("Invalid Choice metadata length");
    const metadata = new ChoiceReader(sheet.take(metadataLength));
    const columns: string[] = [], types: number[] = [];
    while (metadata.remaining) {
      if (columns.length >= 1024) throw new ChoiceWireError("Choice column count exceeds limit");
      columns.push(metadata.string()); types.push(metadata.u8());
    }
    const rows: ChoiceScalar[][] = [];
    while (sheet.remaining) {
      if (++rowCount > MAX_OUTPUT_ROWS) throw new ChoiceWireError("Choice row count exceeds limit");
      const row: ChoiceScalar[] = [];
      for (const type of types) {
        if (++cells > MAX_OUTPUT_CELLS) throw new ChoiceWireError("Choice cell count exceeds limit");
        row.push(decodeChoiceScalar(sheet, type));
      }
      rows.push(row);
    }
    sheets.push({ name, columns, types, rows });
  }
  return sheets;
}
