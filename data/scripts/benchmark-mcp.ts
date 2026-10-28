import { handleRequest } from '../src/app';
const env = {} as Cloudflare.Env;
const cases = [
  ['initialize', { method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cpu', version: '1' } } }],
  ['tools/list', { method: 'tools/list', params: {} }],
  ['invalid Choice call', { method: 'tools/call', params: { name: 'choice_css', arguments: {} } }],
] as const;
for (const [name, message] of cases) {
  const values = [];
  for (let index = 0; index < 110; index++) {
    const start = performance.now();
    const response = await handleRequest(new Request('https://unit.test/data/mcp', { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: index, ...message }) }), env);
    if (response.status !== 200) throw new Error('MCP benchmark request failed');
    await response.arrayBuffer();
    if (index >= 10) values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, runtime: 'local Node, no upstream I/O', samples: values.length, p95_ms: Number(values[94]!.toFixed(3)), max_ms: Number(values.at(-1)!.toFixed(3)) }));
}
