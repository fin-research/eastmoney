type SmokeEnv = Pick<Cloudflare.Env, "DM" | "CHOICE_RPC" | "CAMEL">;

async function smokeChoice(env: SmokeEnv): Promise<Response> {
  const upstream = await env.CHOICE_RPC.fetch(
    new Request("http://choice-rpc.office.internal/health", {
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const body = await upstream.text();
  return Response.json({
    reachable: true,
    upstreamStatus: upstream.status,
    contractVersion: upstream.headers.get("X-Choice-Rpc-Version"),
    health: body.slice(0, 256),
  }, { headers: { "Cache-Control": "no-store" } });
}

async function smokeDm(env: SmokeEnv): Promise<Response> {
  // A real DM application path returns promptly even without authentication;
  // this smoke checks the VPC/Tunnel network path, not the business payload.
  const target = new URL(
    "/onshore-bond-price-apollo/api/rate/matrix/top-case",
    "https://rest.innodealing.com",
  );
  target.searchParams.set("issueDate", "2026-08-29");
  target.searchParams.set("businessModule", "3");
  target.searchParams.set("activeBondType", "2");
  const upstream = await env.DM.fetch(
    new Request(target, { signal: AbortSignal.timeout(10_000) }),
  );
  await upstream.body?.cancel();
  return Response.json({
    reachable: true,
    upstreamStatus: upstream.status,
  }, { headers: { "Cache-Control": "no-store" } });
}

async function smokeCamel(env: SmokeEnv): Promise<Response> {
  const upstream = await env.CAMEL.fetch(
    new Request("http://10.6.88.192:7000/login", {
      signal: AbortSignal.timeout(10_000),
    }),
  );
  await upstream.body?.cancel();
  return Response.json({
    reachable: true,
    upstreamStatus: upstream.status,
  }, { headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: SmokeEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/dm" && pathname !== "/choice" && pathname !== "/camel") {
      return Response.json({ paths: ["/dm", "/choice", "/camel"] }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    try {
      if (pathname === "/dm") return smokeDm(env);
      if (pathname === "/choice") return smokeChoice(env);
      return smokeCamel(env);
    } catch (error) {
      return Response.json(
        {
          reachable: false,
          error: error instanceof Error ? error.name : "unknown",
        },
        {
          status: 504,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  },
} satisfies ExportedHandler<SmokeEnv>;
