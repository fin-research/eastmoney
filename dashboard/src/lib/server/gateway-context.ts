import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { SiteIdentity } from '../identity.ts';

export const CONTEXT_HEADER = 'X-Eastmoney-Gateway-Context';
const identity = z.object({ id: z.string(), auth0Id: z.string(), email: z.string(), issuedAt: z.number(), expiresAt: z.number(),
  authorization: z.object({ name: z.string(), department: z.string().optional(), picture: z.string(),
    roles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional().default('') })),
    permissions: z.array(z.string()), mode: z.enum(['beta-open', 'enforce']) }) });
const contextSchema = z.object({ version: z.literal(1), user: identity.nullable(), choice: z.object({ status: z.union([z.literal(204), z.literal(401), z.literal(403), z.literal(503)]) }) });
export type GatewayContext = z.infer<typeof contextSchema>;
declare global { interface Env { GATEWAY_CONTEXT?: GatewayContext } }

/** Called only by GatewayDashboard, which cannot be selected by a public URL. */
export function readBindingContext(request: Request): GatewayContext {
  try { return contextSchema.parse(JSON.parse(Buffer.from(request.headers.get(CONTEXT_HEADER) ?? '', 'base64url').toString('utf8'))); }
  catch { throw new AccessError(503, '网关上下文不可用'); }
}
/** Application hooks consume in-process metadata, never an Internet header or JWT. */
export function gatewayContext(env: Env): { user: SiteIdentity | null; permissions: string[] } {
  if (!env.GATEWAY_CONTEXT) throw new AccessError(503, '请通过统一网关访问');
  const user = env.GATEWAY_CONTEXT.user;
  return { user, permissions: user?.authorization.permissions ?? [] };
}
