/** Offline reconstruction of Linux EmQuantAPI 2.6.1.3 auth framing; no network I/O. */
import { createHash } from 'node:crypto';

export interface NativeCredentials {
  uid: string;
  ctoken: string;
  utoken: string;
  deviceId: string;
  deviceModel?: string;
  language?: number;
}
export interface NativeSession {
  uid: string;
  token: string;
  sessionId: string;
  ctoken: string;
  utoken: string;
}
export class ChoiceLoginError extends Error {
  constructor(readonly upstreamCode: number) { super('Choice login rejected'); this.name = 'ChoiceLoginError'; }
}
const sdkVersion = '2.6.1.3';
const productId = '100000000093071430';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\x00-\x1f\x7f]/.test(value)) {
    // The name is safe to show; the actual credential must never enter exceptions.
    throw new Error(`Invalid Choice ${name}`);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Choice login response');
  return value as Record<string, unknown>;
}
// JsonCpp FastWriter uses ordered map keys and terminates its JSON with a newline.
function wireJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) + '\n';
}
export function encodeSendFrame(body: Uint8Array, type: number, tail = 0): Uint8Array {
  if (body.length > 1024 * 1024) throw new Error('Choice auth request exceeds limit');
  const frame = new Uint8Array(14 + body.length);
  new DataView(frame.buffer).setUint32(1, frame.length, true);
  frame[5] = 1;
  frame[6] = type;
  frame[13] = tail;
  frame.set(body, 14);
  return frame;
}
export function encodeAutoLogin(credentials: NativeCredentials): Uint8Array {
  const body = wireJson({
    Uid: required(credentials.uid, 'UID'),
    CToken: required(credentials.ctoken, 'CToken'),
    UToken: required(credentials.utoken, 'UToken'),
    DeviceID: required(credentials.deviceId, 'device ID'),
    DeviceModel: credentials.deviceModel ?? 'MACMD5',
    DeviceType: 'PCLinux',
    isForceLogin: '0',
    LoginFrom: 3,
    Language: credentials.language ?? 1,
    ProductType: 'choicesjjk',
  });
  return encodeSendFrame(encoder.encode(`1012$$UserAPILogin$${sdkVersion}$${productId}$3$${body}`), 3);
}
export const encodeLogin = encodeAutoLogin;
export function encodePasswordLogin(account: string, password: string, credentials: Pick<NativeCredentials, 'deviceId'|'deviceModel'|'language'>): Uint8Array {
  const body = wireJson({
    Account: required(account, 'account'),
    Password: createHash('md5').update(required(password, 'password'), 'utf8').digest('hex'),
    DeviceID: required(credentials.deviceId, 'device ID'),
    DeviceModel: credentials.deviceModel ?? 'MACMD5',
    DeviceType: 'PCLinux',
    isForceLogin: '0',
    LoginFrom: 3,
    Language: credentials.language ?? 1,
    ProductType: 'choicesjjk',
  });
  return encodeSendFrame(encoder.encode(`1012$$UserAPILogin$${sdkVersion}$${productId}$5$${body}`), 3);
}
export function decodeLoginResponse(body: Uint8Array): NativeSession {
  if (body.length > 1024 * 1024) throw new Error('Choice auth response exceeds limit');
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(body)); }
  catch { throw new Error('Invalid Choice login JSON'); }
  const root = record(parsed);
  if (root.Code !== '0' && root.Code !== 0) {
    // Do not echo upstream Msg/body: either can include credentials.
    const code = typeof root.Code === 'string' || typeof root.Code === 'number' ? String(root.Code) : 'unknown';
    throw new ChoiceLoginError(/^-?\d+$/.test(code) ? Number(code) : -1);
  }
  const base = record(record(root.Data).BaseInfo);
  return {
    uid: required(base.UniqueId, 'response UID'),
    token: required(base.Token, 'response token'),
    sessionId: required(base.SessionID, 'response session ID'),
    ctoken: required(base.Ctoken, 'response CToken'),
    utoken: required(base.Utoken, 'response UToken'),
  };
}
/** Exchange owns connect, timeout, exact 13-byte response header, bounds and gzip. */
export async function authenticate(credentials: NativeCredentials, exchange: (request: Uint8Array) => Promise<Uint8Array>): Promise<NativeSession> {
  return decodeLoginResponse(await exchange(encodeAutoLogin(credentials)));
}
export function encodeHeartbeatRegistration(session: Pick<NativeSession, 'uid'|'sessionId'>): Uint8Array {
  const uid = required(session.uid, 'UID');
  const sid = required(session.sessionId, 'session ID');
  if (uid.includes(',') || sid.includes(',')) throw new Error('Invalid Choice heartbeat identifier');
  return encodeSendFrame(encoder.encode(`${uid},1,1,2,${sid},${productId}`), 250, 5);
}
export function encodeHeartbeat(): Uint8Array {
  return encodeSendFrame(new Uint8Array(4), 100, 5);
}
export function parseReceiveHeader(header: Uint8Array): {length: number; type: number; compression: number; status: number; extra: number} {
  if (header.length !== 13) throw new Error('Invalid Choice receive header length');
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, true);
  if (length < 13 || length > 1024 * 1024 + 13) throw new Error('Invalid Choice auth frame length');
  return { length, type: header[6]!, compression: header[7]!, status: header[9]!, extra: header[12]! };
}
/** Heartbeat DoThreadProc reads raw type6 / qualifier12; control effects only. */
export function heartbeatControl(header: Uint8Array, body: Uint8Array): 'heartbeat'|'registration'|'evicted'|'disconnected'|'other' {
  parseReceiveHeader(header);
  if (header[6] === 100) return 'heartbeat';
  if (header[6] === 2 && header[12] === 4 && body[0] === 2) return 'evicted';
  if (header[6] === 5 && header[12] === 4) return 'disconnected';
  // Unknown registration acknowledgments stay unknown until semantics confirmed.
  return 'other';
}
