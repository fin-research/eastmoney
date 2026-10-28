import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSse } from "../src/lib/server/ai-stream.ts";

const requireWrangler = createRequire(import.meta.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = requireWrangler("miniflare");
const { build } = requireWrangler("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));

test("real Agents SQLite/alarm runtime streams across requests, persists and archives the fixed conversation", { timeout: 30000 }, async () => {
  const bundled = await build({ stdin: { contents: `
    export { CreditAgent } from './worker/credit-agent.ts';
    import { creditAssistantHttp } from './worker/credit-assistant-http.ts';
    export default { fetch(request, env) { return creditAssistantHttp(request, env,
      { id:'access-test', auth0Id:'auth0|test', email:'test@18.cn', issuedAt:0, expiresAt:9999999999 }); } };
  `, resolveDir: root, sourcefile: "credit-runtime-fixture.ts" }, bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    external: ["cloudflare:*", "node:*"], plugins: [{ name: "runtime-fixtures", setup(plugin) {
      plugin.onResolve({ filter: /credit-assistant\.ts$/ }, args => ({ path: args.path, namespace: "fixture" }));
      plugin.onLoad({ filter: /credit-assistant\.ts$/, namespace: "fixture" }, () => ({ contents: `
        import { env } from 'cloudflare:workers';
        export async function recoverQueuedCreditAnswers() {}
        export async function answerCreditQuestion(options) {
          await env.TEST_GATE.fetch('https://gate.test/ready');
          await options.trace.tool('ai_search', {}, () => []);
          await options.trace.chat({'credit.stage':'decision'}, span => {
            span.modelResponse({status:200,gatewayLogId:'runtime-test',inputTokens:50,outputTokens:10});
          });
          options.progress('正在检索资料');
          options.summary('正在分析公司资产');
          await new Promise(resolve=>setTimeout(resolve,150));
          return {status:'complete',paragraphs:[{text:'公司资产100亿元。',citations:[]}],gaps:[],sources:[],files:[],createdAt:new Date().toISOString()};
        }
      ` }));
    } }] });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const directory = await mkdtemp(join(tmpdir(), "credit-sse-runtime-"));
  const config = convertV4MiniflareOptions({ workers: [{ name: "credit-test", modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-20", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CREDIT_AGENT: { className: "CreditAgent", useSQLite: true } }, r2Buckets: ["EASTMONEY"],
    serviceBindings: { TEST_GATE: async () => { await gate; return new Response("ready"); } } }] });
  const mf = new Miniflare({ ...config, resourcePersistencePath: directory, unsafeObservability: true });
  try {
    await (await mf.getR2Bucket("EASTMONEY")).put("credit/public/2026半年报.pdf", new Uint8Array([37, 80, 68, 70]));
    const request = (path, body) => mf.dispatchFetch("https://test.example/api/credit-assistant/" + path, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: { origin: "https://test.example", "content-type": "application/json" },
    });
    assert.equal((await request("session", { question: "公司资产多少？" })).status, 202);
    const response = await request("session/events");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    releaseGate();
    const events = [];
    await readSse(response.body, event => events.push({ type: event.event, data: event.event === "result" ? JSON.parse(event.data) : event.data }), 100000);
    assert.ok(events.some(event => event.type === "progress" && event.data === "正在分析公司资产"));
    assert.equal(events.at(-1).type, "result");
    assert.equal(events.at(-1).data.running, false);
    const read = () => request("session").then(response => response.json());
    const saved = await read();
    assert.equal(saved.turns[0].answer.paragraphs[0].text, "公司资产100亿元。");
    assert.equal(saved.progress, "");
    // Read the real workerd tail collector's local SQLite store, not a fake span
    // recorder. The synthetic model above avoids network calls in this test.
    const traceDirectory = join(directory, "observability");
    let spans = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const databases = (await readdir(traceDirectory, { recursive: true })).filter(file => file.endsWith(".sqlite"));
      spans = databases.flatMap(file => {
        const db = new Database(join(traceDirectory, file), { readonly: true, fileMustExist: true });
        try {
          if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spans'").get()) return [];
          return db.prepare("SELECT span_id, parent_id, name, duration_ms, json(attributes) AS attributes FROM spans WHERE name LIKE 'invoke_agent %' OR name LIKE 'chat %' OR name LIKE 'execute_tool %'")
            .all().map(row => ({ ...row, attributes: JSON.parse(row.attributes) }));
        }
        finally { db.close(); }
      });
      if (spans.some(span => span.name === "invoke_agent CreditAgent" && span.attributes["credit.outcome"] === "complete")) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const rootSpan = spans.find(span => span.name === "invoke_agent CreditAgent");
    assert.ok(rootSpan, "workerd must emit the custom agent span");
    assert.equal(rootSpan.attributes["credit.run_id"], saved.questionId);
    assert.equal(rootSpan.attributes["gen_ai.conversation.id"], saved.conversationId);
    const modelSpan = spans.find(span => span.name === "chat gpt-6-luna");
    assert.equal(modelSpan.parent_id, rootSpan.span_id);
    assert.equal(modelSpan.attributes["gen_ai.usage.input_tokens"], 50);
    const searchSpan = spans.find(span => span.name === "execute_tool ai_search");
    assert.equal(searchSpan.parent_id, rootSpan.span_id);
    assert.ok(spans.every(span => span.duration_ms !== null && span.duration_ms >= 0));
    assert.doesNotMatch(JSON.stringify(spans.map(span => span.attributes)), /公司资产|auth0\||test@18.cn/);
    const fresh = await request("session/new", {});
    assert.equal(fresh.status, 200);
    assert.equal((await read()).turns.length, 0);
    // A second new-conversation action also succeeds: archive IDs and table
    // creation work in SQLite, rather than only in the mock Agent used by unit tests.
    assert.equal((await request("session/new", {})).status, 200);
  } finally { releaseGate(); await mf.dispose(); await rm(directory, { recursive: true }); }
});
