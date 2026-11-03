import { z } from 'zod';
import type { ChoiceEndpoint } from './transport';

const endpoint = z.object({ hostname: z.string().regex(/^[a-zA-Z0-9.-]+$/).max(253), port: z.number().int().min(1).max(65535) });
const serverSchema = z.object({
  '3': endpoint, '6': endpoint, '19': endpoint, '20': endpoint,
  statisticsOrigin: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; }),
});
export type ChoiceServers = Record<'3'|'6'|'19'|'20', ChoiceEndpoint> & { statisticsOrigin: string };
const device = { deviceId: z.string().min(1).max(256), deviceModel: z.string().min(1).max(256), language: z.number().int().min(0).max(2).optional() };
const credentialSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto'), uid: z.string().min(1).max(256), ctoken: z.string().min(1).max(4096), utoken: z.string().min(1).max(4096), ...device }),
  z.object({ mode: z.literal('password'), account: z.string().min(1).max(254), password: z.string().min(1).max(254), ...device }),
]);
export type ChoiceCredentials = z.infer<typeof credentialSchema>;
export function parseNativeConfig(servers: string, credentials: string): { servers: ChoiceServers; credentials: ChoiceCredentials } {
  try {
    if (servers.length > 8192 || credentials.length > 16384) throw new Error();
    return { servers: serverSchema.parse(JSON.parse(servers)), credentials: credentialSchema.parse(JSON.parse(credentials)) };
  } catch { throw new Error('Choice native configuration is missing or invalid'); }
}
