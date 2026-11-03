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
    ctoken: required(base.Ctoken, 'response CToken'),
    utoken: required(base.Utoken, 'response UToken'),
  };
}
/** Exchange owns connect, timeout, exact 13-byte response header, bounds and gzip. */
export async function authenticate(credentials: NativeCredentials, exchange: (request: Uint8Array) => Promise<Uint8Array>): Promise<NativeSession> {
  return decodeLoginResponse(await exchange(encodeAutoLogin(credentials)));
}
