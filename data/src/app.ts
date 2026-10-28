import { handleChinamoneyRoute } from "./chinamoney";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validateResourceRequest } from "./resources";
import { handleMcp } from "./mcp";

import { handleChoiceRoute } from "./choice/routes";
import { handleDmRoute } from "./dm/routes";
import { handleDocs } from "./docs";
import { handleEastmoneyRoute } from "./eastmoney-routes";
import { handleGraphql } from "./graphql";
import { errorResponse, jsonResponse, shanghaiToday, withNoStore } from "./http";
import { internalPathname } from "./routing";
import { handleTradingCalendarRoute } from "./trading-calendar";

const DEVELOPMENT_ORIGINS = new Set([
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

type DataApp = Hono<{ Bindings: Cloudflare.Env }>;
type LegacyRoute = (
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
) => Promise<Response | null>;

function corsResponse(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !DEVELOPMENT_ORIGINS.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "*");
    headers.set("Access-Control-Allow-Headers", "*");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function finalizeResponse(request: Request, response: Response): Response {
  return corsResponse(request, withNoStore(response));
}

function registerLegacyRoutes(
  app: DataApp,
  paths: readonly string[],
  handler: LegacyRoute,
): void {
  for (const path of paths) {
    app.all(path, async (context) => {
      const pathname = new URL(context.req.url).pathname;
      const response = await handler(context.req.raw, context.env, pathname);
      return response ?? context.notFound();
    });
  }
}

function createApp(): DataApp {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.use("*", async (context, next) => {
    if (context.req.method === "OPTIONS") {
      return finalizeResponse(
        context.req.raw,
        new Response(null, { status: 200 }),
      );
    }
    validateResourceRequest(context.req.raw, new URL(context.req.url).pathname);
    await next();
    context.res = finalizeResponse(context.req.raw, context.res);
  });

  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/config", (context) => context.json({ defaultDate: shanghaiToday() }));
  app.all("/trading-days", (context) => handleTradingCalendarRoute(context.req.raw, context.env));

  for (const path of ["/openapi.json", "/docs", "/redoc"] as const) {
    app.get(
      path,
      (context) =>
        handleDocs(new URL(context.req.url).pathname) ?? context.notFound(),
    );
  }

  app.all("/mcp", handleMcp);

  app.all("/graphql", (context) => handleGraphql(context.req.raw, context.env));

  registerLegacyRoutes(
    app,
    [
      "/choice/csd",
      "/choice/css",
      "/choice/ctr",
      "/choice/edb",
      "/choice/data-statistics",
    ],
    handleChoiceRoute,
  );
  registerLegacyRoutes(
    app,
    [
      "/cfets",
      "/cfets-histories",
      "/bond-top-case",
      "/futures-latest",
      "/primary-issues",
      "/broker-bond-registrations",
      "/omo",
      "/today-trades",
      "/favorite-quotes",
      "/bond-infos",
      "/news",
      "/news/:articleId",
      "/wechat-articles",
    ],
    handleDmRoute,
  );
  registerLegacyRoutes(
    app,
    ["/industry", "/stock-summary", "/margin"],
    handleEastmoneyRoute,
  );

  registerLegacyRoutes(app, ["/chinamoney/shibor"], handleChinamoneyRoute);

  app.notFound(() => jsonResponse({ detail: "Not Found" }, 404));
  app.onError((error, context) =>
    finalizeResponse(context.req.raw, error instanceof HTTPException ? error.getResponse() : errorResponse(error)),
  );
  return app;
}

export const app = createApp();

function requestForInternalPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  if (url.pathname === pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

export function handleRequest(
  request: Request,
  env: Cloudflare.Env,
  context?: ExecutionContext,
): Promise<Response> {
  const pathname = internalPathname(new URL(request.url).pathname);
  if (pathname === null) {
    return Promise.resolve(
      finalizeResponse(request, jsonResponse({ detail: "Not Found" }, 404)),
    );
  }
  return Promise.resolve(
    app.fetch(requestForInternalPath(request, pathname), env, context),
  );
}
