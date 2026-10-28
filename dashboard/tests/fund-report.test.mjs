import assert from "node:assert/strict";
import test from "node:test";

import {
  fundReportDateFromFileName,
  fundReportFileName,
  fundReportObjectKey,
} from "../src/lib/fund-report.ts";
import {
  archiveFundReportRequest,
  FundReportError,
  fundReportHeaders,
  getFundReport,
  listFundReports,
} from "../src/lib/server/fund-report.ts";

test("资金日报文件名日期统一为 ISO 文件名和 R2 前缀", () => {
  assert.equal(
    fundReportDateFromFileName("资金日报驾驶舱交互版_20260824.html"),
    "2026-08-24",
  );
  assert.equal(
    fundReportDateFromFileName("2026-08-24.html"),
    "2026-08-24",
  );
  assert.equal(
    fundReportDateFromFileName("资金日报_2026-08-24.html"),
    "2026-08-24",
  );
  assert.equal(fundReportDateFromFileName("资金日报_20260230.html"), null);
  assert.equal(fundReportDateFromFileName("资金日报.html"), null);
  assert.equal(fundReportFileName("2026-08-24"), "2026-08-24.html");
  assert.equal(
    fundReportObjectKey("2026-08-24"),
    "fund-reports/2026-08-24.html",
  );
});

test("资金日报上传校验 HTML 后按日期写入 R2", async () => {
  const html = new Blob(
    ["<!doctype html><html><head></head><body>资金日报</body></html>"],
    { type: "text/html" },
  );
  const calls = [];
  const bucket = {
    async head(key) {
      calls.push(["head", key]);
      return null;
    },
    async put(key, value, options) {
      const bytes = await new Response(value).arrayBuffer();
      calls.push(["put", key, options]);
      return {
        key,
        size: bytes.byteLength,
        etag: "fund-report-etag",
      };
    },
  };

  const result = await archiveFundReportRequest(
    uploadRequest(html, "资金日报驾驶舱交互版_20260824.html"),
    bucket,
  );

  assert.equal(result.date, "2026-08-24");
  assert.equal(result.fileName, "2026-08-24.html");
  assert.equal(result.url, "/fund-report/2026-08-24.html");
  assert.equal(result.key, "fund-reports/2026-08-24.html");
  assert.equal(result.replaced, false);
  assert.deepEqual(calls.map(([action]) => action), ["head", "put"]);
  assert.equal(calls[1][2].httpMetadata.contentType, "text/html; charset=utf-8");
  assert.equal(
    calls[1][2].customMetadata.originalName,
    "资金日报驾驶舱交互版_20260824.html",
  );
});

test("同日报告再次上传标记为更新", async () => {
  const html = new Blob(["<html><body>updated</body></html>"], {
    type: "text/html",
  });
  const bucket = {
    async head() {
      return { key: "fund-reports/2026-08-24.html" };
    },
    async put(key) {
      return { key, size: html.size, etag: "updated-etag" };
    },
  };
  const result = await archiveFundReportRequest(
    uploadRequest(html, "2026-08-24.html"),
    bucket,
  );
  assert.equal(result.replaced, true);
});

test("资金日报上传拒绝跨站、无日期和非 HTML 内容", async () => {
  const html = new Blob(["<html></html>"], { type: "text/html" });
  const noWriteBucket = {
    async head() {
      assert.fail("非法请求不应读取 R2");
    },
    async put() {
      assert.fail("非法请求不应写入 R2");
    },
  };
  await assert.rejects(
    archiveFundReportRequest(
      uploadRequest(html, "资金日报_20260824.html", {
        Origin: "https://attacker.example",
      }),
      noWriteBucket,
    ),
    (error) => error instanceof FundReportError && error.status === 403,
  );
  await assert.rejects(
    archiveFundReportRequest(
      uploadRequest(html, "资金日报.html"),
      noWriteBucket,
    ),
    (error) => error instanceof FundReportError && error.status === 400,
  );

  const text = new Blob(["not html"], { type: "text/html" });
  const inspectBucket = {
    async head() {
      assert.fail("非 HTML 内容不应读取 R2");
    },
    async put() {
      assert.fail("非 HTML 内容不应写入 R2");
    },
  };
  await assert.rejects(
    archiveFundReportRequest(
      uploadRequest(text, "资金日报_20260824.html"),
      inspectBucket,
    ),
    (error) => error instanceof FundReportError && error.status === 400,
  );
});

test("资金日报上传校验已有请求长度并兼容代理省略 Content-Length", async () => {
  const html = new Blob(["<html></html>"], { type: "text/html" });
  const bucket = {
    async head() {
      assert.fail("长度不一致时不应读取 R2");
    },
    async put() {
      assert.fail("长度不一致时不应写入 R2");
    },
  };
  await assert.rejects(
    archiveFundReportRequest(
      uploadRequest(html, "资金日报_20260824.html", {
        "Content-Length": String(html.size + 1),
      }),
      bucket,
    ),
    (error) => error instanceof FundReportError && error.status === 400,
  );

  const requestWithoutLength = uploadRequest(
    html,
    "资金日报_20260824.html",
  );
  requestWithoutLength.headers.delete("Content-Length");
  const writableBucket = {
    async head() {
      return null;
    },
    async put(key) {
      return { key, size: html.size, etag: "no-content-length" };
    },
  };
  const result = await archiveFundReportRequest(
    requestWithoutLength,
    writableBucket,
  );
  assert.equal(result.fileName, "2026-08-24.html");
});

test("上传模态框保留文件选择与上传主操作", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(
    new URL("../src/lib/FundReportUploadDialog.svelte", import.meta.url),
    "utf8",
  );
  assert.match(page, /<Modal[\s\S]*?aria-labelledby="fund-report-upload-title"/);
  assert.match(page, /upload-file-input[\s\S]*?type="file"/);
  assert.match(
    page,
    /<footer class="upload-actions">[\s\S]*?<Button[^>]*variant="default"[\s\S]*?upload-button[\s\S]*?type="submit"/,
  );
  assert.match(page, /disabled=\{!selectedFile \|\| uploading\}/);
});

test("资金日报读取只使用日期派生 key 并添加隔离响应头", async () => {
  const html = "<html><body><script>window.ready = true</script></body></html>";
  const object = {
    body: new Response(html).body,
    size: new TextEncoder().encode(html).byteLength,
    httpEtag: '"etag-read"',
    writeHttpMetadata(headers) {
      headers.set("Cache-Control", "public, max-age=300");
    },
  };
  const bucket = {
    async get(key) {
      assert.equal(key, "fund-reports/2026-08-24.html");
      return object;
    },
  };
  const stored = await getFundReport(bucket, "2026-08-24");
  const headers = fundReportHeaders(stored, "2026-08-24");
  assert.match(headers.get("Content-Security-Policy"), /sandbox allow-scripts/);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("ETag"), '"etag-read"');
});

test("历史资金日报枚举固定前缀、过滤非法对象并按日期倒序", async () => {
  const calls = [];
  const bucket = {
    async list(options) {
      calls.push(options);
      if (!options.cursor) {
        return {
          objects: [
            reportObject("fund-reports/2026-08-22.html", 2200),
            reportObject("fund-reports/readme.html", 100),
            reportObject("fund-reports/archive/2026-08-23.html", 2300),
          ],
          delimitedPrefixes: [],
          truncated: true,
          cursor: "next-page",
        };
      }
      return {
        objects: [reportObject("fund-reports/2026-08-25.html", 2500)],
        delimitedPrefixes: [],
        truncated: false,
      };
    },
  };

  const reports = await listFundReports(bucket);
  assert.deepEqual(calls, [
    { prefix: "fund-reports/", cursor: undefined },
    { prefix: "fund-reports/", cursor: "next-page" },
  ]);
  assert.deepEqual(
    reports.map(({ date, url, size }) => ({ date, url, size })),
    [
      {
        date: "2026-08-25",
        url: "/fund-report/2026-08-25.html",
        size: 2500,
      },
      {
        date: "2026-08-22",
        url: "/fund-report/2026-08-22.html",
        size: 2200,
      },
    ],
  );
});

test("资金日报列表页呈现历史入口、空状态和读取失败状态", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(
    new URL("../src/routes/fund-report/+page.svelte", import.meta.url),
    "utf8",
  );
  assert.match(page, /<h2 id="fund-report-list-title">历史资金日报<\/h2>/);
  assert.match(page, /href=\{report\.url\}/);
  assert.match(page, /暂无历史资金日报/);
  assert.match(page, /资金日报列表暂时无法读取|data\.loadError/);
});

function reportObject(key, size) {
  return {
    key,
    size,
    uploaded: new Date("2026-08-25T08:00:00.000Z"),
  };
}

function uploadRequest(body, fileName, extraHeaders = {}) {
  return new Request("https://eastmoney.hasbai.xyz/api/fund-report", {
    method: "POST",
    headers: {
      "Content-Type": body.type,
      "Content-Length": String(body.size),
      "X-Fund-Report-Filename": encodeURIComponent(fileName),
      "X-Fund-Report-Size": String(body.size),
      ...extraHeaders,
    },
    body,
  });
}
