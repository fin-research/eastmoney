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
  let renderFinancingForecast;
  try {
    ({ renderFinancingForecast } =
      await server.ssrLoadModule("/src/charts/financing-model.ts"));
  } finally {
    await server.close();
  }

  assert.equal(typeof renderFinancingForecast, "function");
  assert.equal(colors.ink, "#202622");
  assert.equal(colors.paper, "#ffffff");
  assert.match(fontFamily, /PingFang SC/);
  assert.equal(chartTextSize, 16);
  assert.equal(rem(1.25), 20);
});
