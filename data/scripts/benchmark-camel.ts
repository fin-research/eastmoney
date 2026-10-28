/** Local CPU evidence with a cached session and a VPC sink; never calls the office system. */
import { cpuUsage } from 'node:process';
import { handleCamelRequest } from '../src/camel/routes.ts';

const env = {
  CAMEL: { fetch: async (request: Request) => {
    const reader = request.body?.getReader();
    if (reader) while (!(await reader.read()).done) { /* emulate a streaming VPC sink */ }
    return Response.json({ success: true, data: { id: 'uploaded' } });
  } },
  CAMEL_LIMIT: { limit: async () => ({ success: true }) },
} as unknown as Cloudflare.Env;
const dependencies = { cache: {
  match: async () => Response.json({ accessToken: 'cached', tokenName: 'name',
    deviceId: 'f6e48a8d-da7f-4735-b897-8d188b374677', expiresAt: Date.now() + 3600000 }),
  put: async () => {}, delete: async () => true,
} };
for (const bytes of [100_000, 1_000_000, 10_000_000]) {
  const samples: number[] = [];
  for (let index = 0; index < 25; index++) {
    const request = new Request('https://data/camel/attachments', { method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'trade.pdf' }, body: new Uint8Array(bytes) });
    const start = cpuUsage();
    const response = await handleCamelRequest(request, env, dependencies);
    await response!.arrayBuffer();
    const used = cpuUsage(start);
    if (index >= 5) samples.push((used.user + used.system) / 1000);
  }
  samples.sort((left, right) => left - right);
  console.log(JSON.stringify({ bytes, samples: samples.length, unit: 'ms', p50: samples[10], p95: samples[18], max: samples[19] }));
}
