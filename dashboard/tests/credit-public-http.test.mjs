import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { creditAgentName } from "../src/lib/server/credit-session.ts";
import { recordingCreditTracing } from "./helpers/credit-trace-recorder.mjs";
import { legacyCreditFileId } from "../src/lib/server/credit-public-files.ts";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const agents = moduleUrl(`export { isDurableObjectCodeUpdateReset, isPlatformTransientError } from ${JSON.stringify(new URL("../node_modules/agents/dist/retries.js", import.meta.url).href)};
export class Agent {
  constructor(ctx, env) { this.ctx = { ...ctx, storage: { transactionSync: operation => operation() } }; this.env = env; this.jobs = []; }
  get state() { return this._state ??= structuredClone(this.initialState); }
  setState(state) { this._state = state; }
  async schedule(_delay, callback, payload) { this.jobs.push({callback,payload}); }
  sql() { return []; }
  getQueues() { return []; }
} export async function getAgentByName(binding, name) { return binding.get(name); }`);
const assistant = moduleUrl(`export { recoverQueuedCreditAnswers } from ${JSON.stringify(new URL("../src/lib/server/credit-assistant.ts", import.meta.url).href)};
export async function answerCreditQuestion(options) { return globalThis.creditTestAnswer(options); }`);
const workers = moduleUrl(`export const tracing = {enterSpan(...args) {return globalThis.creditTestTracing.enterSpan(...args);}};`);
async function workerModule(file) {
  const url = new URL(`../worker/${file}`, import.meta.url);
  const source = (await readFile(url, "utf8")).replace(/from "([^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(
    specifier === "agents" ? agents : specifier === "cloudflare:workers" ? workers : specifier.endsWith("/credit-assistant.ts") ? assistant : new URL(specifier, url).href)}`);
  return import(moduleUrl(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText));
}
const { CreditAgent } = await workerModule("credit-agent.ts");
const { creditAssistantHttp } = await workerModule("credit-assistant-http.ts");
const publicKey = "credit/public/年度报告.pdf";
const doc = { id: publicKey, title: "年度报告.pdf" };
const origin = "https://test.example";
const testUser = { id: "access-test", auth0Id: "auth0|test", email: "test@18.cn", issuedAt: 0, expiresAt: 9999999999 };
function setup() {
  const { tracing, spans } = recordingCreditTracing();
  globalThis.creditTestTracing = tracing;
  globalThis.creditTestAnswer = async () => ({ status: "complete", paragraphs: [], gaps: [],
    sources: [], files: [{ id: doc.id, title: doc.title, url: `/api/credit-assistant/files/${encodeURIComponent(doc.title)}` }],
    createdAt: new Date().toISOString() });
  const sessions = new Map();
  const reads = [];
  const env = { EASTMONEY: { list: async () => ({ objects: [{ key: publicKey, size: 4,
    uploaded: new Date("2026-09-07T00:00:00Z"), httpEtag: "test-etag" }], truncated: false }), get: async key => {
    reads.push(key);
    if (key !== publicKey) return null;
    return { body: "file", size: 4, httpEtag: "test-etag", range: { offset: 0, length: 4 } };
  } }, CREDIT_SEARCH: { search: async () => ({ chunks: [] }) }, CREDIT_AGENT: { get: name => {
    if (!sessions.has(name)) { const agent = new CreditAgent({ id: { toString: () => name } }, env); agent.fetch = request => agent.onRequest(request); sessions.set(name, agent); }
    return sessions.get(name);
  } } };
  async function request(path, body, method = body ? "POST" : "GET", options = {}) {
    return creditAssistantHttp(new Request(origin + "/api/credit-assistant/" + path, {
      method, headers: { origin, "content-type": "application/json", ...options.headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, Object.hasOwn(options, "user") ? options.user : testUser);
  }
  return { sessions, reads, request, spans };
}

test("ordinary question creates a user session and serves only public files from eastmoney", async () => {
  const app = setup();
  assert.equal((await app.request("session", { question: "年度报告" })).status, 202);
  const agent = app.sessions.get(creditAgentName(testUser.auth0Id));
  assert.ok(agent);
  await agent.answerQuestion(agent.jobs[0].payload);
  const state = await (await app.request("session")).json();
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].answer.files[0].id, doc.id);
  assert.equal((await app.request("files/" + encodeURIComponent(doc.title))).status, 200);
  assert.equal((await app.request("files/" + legacyCreditFileId(publicKey))).status, 200);
  assert.equal((await app.request("files/" + encodeURIComponent("missing.pdf"))).status, 404);
  assert.ok(app.reads.includes(publicKey));
  assert.ok(app.reads.every(key => key.startsWith("credit/")));
});

test("session is isolated by verified user and accepts no institution selection", async () => {
  const app = setup();
  assert.equal((await app.request("session", null, "GET", { user: null })).status, 401);
  assert.equal((await app.request("session", { institutionName: "银行", question: "报告" })).status, 400);
  assert.equal((await app.request("session/institution", { institutionName: "银行" })).status, 405);
  await app.request("session", { question: "报告" });
  const agent = app.sessions.get(creditAgentName(testUser.auth0Id));
  await agent.answerQuestion(agent.jobs[0].payload);
  const another = { ...testUser, auth0Id: "auth0|other" };
  const other = await (await app.request("session", null, "GET", { user: another,
    headers: { "x-user-id": testUser.auth0Id } })).json();
  assert.equal(other.turns.length, 0);
  assert.equal((await app.request("session/new", {}, "POST")).status, 200);
  assert.equal((await (await app.request("session")).json()).turns.length, 0);
});

test("same-origin and byte bounds remain enforced", async () => {
  const app = setup();
  assert.equal((await app.request("session", { question: "报告" }, "POST", { headers: { origin: "https://other.example" } })).status, 403);
  assert.equal((await app.request("session", { question: "   " })).status, 400);
  assert.equal((await app.request("session", { question: "大".repeat(1024 * 1024) })).status, 413);
});
