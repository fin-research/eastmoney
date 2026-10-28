// Opt-in, paid historical replay. No tools, live data, R2 writes or notifications.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { generateAiGatewayObject } from "../src/lib/server/ai-gateway.ts";
import { MARKET_BRIEFING_SYSTEM, MARKET_BRIEFING_PROMPT_VERSION, marketBriefingOutputSchema, buildMarketBriefingPrompt, assertMarketBriefingQuality } from "../src/lib/server/market-briefing.ts";
import { reportDataSchema } from "../src/market-report.ts";

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const requestPath = arg("request");
const date = arg("date");
const outputDir = arg("output-dir");
if (!requestPath || !outputDir || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  throw new Error("Usage: node scripts/evaluate-market-briefing.mjs --request=historical-request.json --date=YYYY-MM-DD --output-dir=outside-repo [--report=report.json] [--baseline]");
}
if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid date");
if (!process.env.CF_AIG_TOKEN) throw new Error("CF_AIG_TOKEN is required; never pass credentials on the command line");
const historical = JSON.parse(await readFile(requestPath, "utf8"));
// Copy only user text, never historical headers, tools or assistant outputs.
let input = historical.input;
if (!Array.isArray(input) || !input.length || input.some(item => item.role !== "user" || typeof item.content !== "string")) {
  throw new Error("Historical request must contain only user text inputs");
}
const newsDates = input.flatMap(item => [...item.content.matchAll(/^【\d+】(\d{4}-\d{2}-\d{2})/gm)].map(match => match[1]));
if (!newsDates.includes(date) || newsDates.some(value => value > date)) {
  throw new Error("Historical news dates do not match replay date; check the Gateway request mapping");
}
const sourceInputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
const baseline = process.argv.includes("--baseline");
const reportPath = arg("report");
if (reportPath) {
  const report = reportDataSchema.strip().parse(JSON.parse(await readFile(reportPath, "utf8")));
  if (report.report_date !== date) throw new Error("Evidence date mismatch");
  input = [{ role: "user", content: buildMarketBriefingPrompt(input.map(item => item.content).join("\n\n"), report) }];
}
const instructions = baseline ? historical.instructions : MARKET_BRIEFING_SYSTEM;
if (typeof instructions !== "string" || !instructions.trim()) throw new Error("Missing instructions");
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const version = baseline ? "historical-baseline" : MARKET_BRIEFING_PROMPT_VERSION;
const hash = text => createHash("sha256").update(text).digest("hex");
const inputHash = hash(JSON.stringify(input));
const promptHash = hash(instructions);
const startedAt = new Date().toISOString();
const prefix = resolve(outputDir, `${date}-${version}-${promptHash.slice(0, 8)}-${inputHash.slice(0, 12)}`);
await mkdir(resolve(outputDir), { recursive: true });
try {
  await writeFile(`${prefix}.started.json`, JSON.stringify({ date, startedAt, inputHash, promptHash, pid: process.pid }), { flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  try {
    const previous = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
    console.log(JSON.stringify({ file: `${prefix}.json`, reused: true, gatewayLogId: previous.telemetry?.gatewayLogId }));
    process.exit(previous.error || previous.qualityError ? 1 : 0);
  } catch (readError) {
    if (readError.code !== "ENOENT") throw readError;
    throw new Error("This replay was already started. Inspect its process before recovery; do not start a duplicate request.");
  }
}
await writeFile(`${prefix}.input.json`, JSON.stringify({ instructions, input, reportDate: date, requestPath: resolve(requestPath), sourceInputHash }, null, 2));
let telemetry;
try {
  const output = await generateAiGatewayObject({
    accountId: config.vars.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: config.vars.AI_GATEWAY_ID,
    token: process.env.CF_AIG_TOKEN,
  }, [{ role: "system", content: instructions }, ...input],
  // Keep baseline schema descriptions unchanged for fixed-input comparisons.
  baseline ? z.object({ stock: z.string().trim().min(1), bond: z.string().trim().min(1) }).strict() : marketBriefingOutputSchema,
  "market_briefing", {
    taskType: "market_briefing", retry: false, requestTimeoutMs: 300_000,
    promptCacheKey: `market-briefing-evaluation:${version}:${promptHash.slice(0, 12)}`,
    metadata: { report_date: date, prompt_version: version, tags: "market-briefing,evaluation,historical-no-search" },
    onTelemetry: value => { telemetry = { ...telemetry, ...value }; },
  });
  const metrics = Object.fromEntries(Object.entries(output).map(([key, text]) => [key, {
    characters: [...text.replace(/\s/g, "")].length,
    conditionalWords: (text.match(/如果|倘若|若|反之|否则/g) ?? []).length,
    watchWords: (text.match(/后续关注|仍需观察|有待观察/g) ?? []).length,
    completeSentence: /[。！？]$/.test(text),
  }]));
  let qualityError = null;
  try { assertMarketBriefingQuality(output); } catch { qualityError = "length_or_incomplete_sentence"; }
  await writeFile(`${prefix}.json`, JSON.stringify({ date, version, inputHash, promptHash, startedAt,
    completedAt: new Date().toISOString(), telemetry, output, metrics, qualityError }, null, 2));
  console.log(JSON.stringify({ file: `${prefix}.json`, date, metrics, qualityError, gatewayLogId: telemetry?.gatewayLogId }));
  if (!baseline && qualityError) process.exitCode = 1;
} catch (error) {
  // Never serialize request headers, credentials, raw provider bodies or input.
  await writeFile(`${prefix}.json`, JSON.stringify({ date, version, inputHash, promptHash, startedAt,
    completedAt: new Date().toISOString(), telemetry, error: { name: error.name, status: error.status ?? null,
      message: error.message.replaceAll(process.env.CF_AIG_TOKEN, "[redacted]").slice(0, 500) } }, null, 2));
  console.error(JSON.stringify({ file: `${prefix}.json`, error: error.name, status: error.status ?? null, gatewayLogId: telemetry?.gatewayLogId }));
  process.exitCode = 1;
}
