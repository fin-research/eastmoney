import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

test("融资择时图表模块可在 SSR 环境加载且公共配置使用回退值", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.getComputedStyle, "undefined");
  assert.equal(typeof globalThis.ResizeObserver, "undefined");

  const { chartTextSize, colors, fontFamily, rem } = await import(
    "../src/charts/common.ts"
  );
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
  });
  let financingDriverRadarScale;
  let renderFinancingForecast;
  try {
    ({ financingDriverRadarScale, renderFinancingForecast } =
      await server.ssrLoadModule("/src/charts/financing-model.ts"));
  } finally {
    await server.close();
  }

  assert.equal(typeof renderFinancingForecast, "function");
  assert.deepEqual(
    financingDriverRadarScale([
      { support_score: 46.63 },
      { support_score: 57.79 },
    ]),
    { min: 40, max: 60 },
  );
  assert.deepEqual(
    financingDriverRadarScale([{ support_score: 82 }]),
    { min: 15, max: 85 },
  );
  assert.equal(colors.ink, "#202622");
  assert.equal(colors.paper, "#ffffff");
  assert.match(fontFamily, /PingFang SC/);
  assert.equal(chartTextSize, 16);
  assert.equal(rem(1.25), 20);
});
