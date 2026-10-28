// Accessible only through the named ResearchReport service entrypoint.
export async function serveResearchReport(request, assets) {
  const url = new URL(request.url);
  if (!['/README.md','/REPORT.html'].includes(url.pathname) || url.search) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  url.pathname='/README.md';
  const response = await assets.fetch(new Request(url, request));
  if (response.status !== 200) return new Response('Report unavailable', { status: 503 });
  const result = new Response(request.method === 'HEAD' ? null : response.body, response);
  result.headers.set('Content-Type', 'text/markdown; charset=utf-8');
  result.headers.set('Cache-Control', 'no-store, private');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'SAMEORIGIN');
  return result;
}
