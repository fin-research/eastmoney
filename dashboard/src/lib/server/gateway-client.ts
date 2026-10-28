import { Buffer } from 'node:buffer';
import type { SiteIdentity } from '../identity.ts';
import { CONTEXT_HEADER } from './gateway-context.ts';

export class GatewayServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function identityRequest(env: Pick<Env, 'IDENTITY'>, path: string, identity: SiteIdentity | null = null, body?: unknown): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json', [CONTEXT_HEADER]: Buffer.from(JSON.stringify({ version: 1, user: identity, choice: { status: 401 } })).toString('base64url') });
  return env.IDENTITY.fetch(new Request('https://identity.internal' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}
export async function identityJson<T>(env: Pick<Env, 'IDENTITY'>, path: string, identity: SiteIdentity | null = null, body?: unknown): Promise<T> {
  const response = await identityRequest(env, path, identity, body);
  const value: unknown = await response.json();
  if (!response.ok) {
    const detail = value && typeof value === 'object' && 'detail' in value ? String(value.detail) : '身份服务暂时不可用';
    throw new GatewayServiceError(response.status, detail);
  }
  return value as T;
}
