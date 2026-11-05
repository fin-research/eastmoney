// Local, resumable backfill of nodes and claims from the archived report Markdown.
//
//   node --env-file=<path to the untracked root .env> --import tsx scripts/backfill-graph.mjs \
//     [--from 2026-07-01] [--limit 30] [--concurrency 6] [--dry-run] [--out results.jsonl]
//
// Reads D1 and R2 through the local wrangler login, calls the model through AI Gateway with
// CF_AIG_TOKEN, and writes `node` / `claim` rows. Articles are processed newest first and an
// article is pending until its prompt_version is current, so an interrupted run just resumes.
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { articleObjectKey } from "../src/article.ts";
import { ARTICLE_FEATURE_PROMPT_VERSION, extractFeaturesForArticle, RECENT_LABEL_LIMIT } from "../src/feature-extraction.ts";
import { graphReplaceStatements } from "../src/feature-sql.ts";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules/.bin/wrangler");
// Small batches: wrangler sends them as one /query request (see d1Command).
const FLUSH_EVERY = 5;

const args = parseArgs(process.argv.slice(2));
const from = args.from ?? "2026-07-01";
const limit = args.limit ? Number(args.limit) : 100000;
const concurrency = Number(args.concurrency ?? 6);
const dryRun = "dry-run" in args;
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) fail("--from must be YYYY-MM-DD");
if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail("--concurrency must be 1-16");
if (!process.env.CF_AIG_TOKEN) fail("CF_AIG_TOKEN is not set (pass the untracked root .env with --env-file)");

const config = await readFile(join(root, "wrangler.jsonc"), "utf8");
const credentials = {
  accountId: /"CLOUDFLARE_ACCOUNT_ID":\s*"([^"]+)"/.exec(config)?.[1] ?? fail("account id missing in wrangler.jsonc"),
  gatewayId: /"AI_GATEWAY_ID":\s*"([^"]+)"/.exec(config)?.[1] ?? fail("gateway id missing in wrangler.jsonc"),
  token: process.env.CF_AIG_TOKEN,
};
// The local wrangler login owns D1 and R2 access; an API token in the env must not override it.
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;
delete wranglerEnv.CF_AIG_TOKEN;

async function wranglerRun(commandArgs) {
  // detached: Ctrl-C reaches only this script, so in-flight writes can finish.
  const { stdout } = await run(wrangler, commandArgs, { cwd: root, env: wranglerEnv, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", detached: true });
  return stdout;
}

async function d1Query(sql) {
  const out = await wranglerRun(["d1", "execute", "DB", "--remote", "--json", "--command", sql]);
  const parsed = JSON.parse(out.toString("utf8"));
  return parsed[0]?.results ?? [];
}

// `d1 execute --file` goes through the D1 import API, which takes the whole database offline
// while it runs. `--command` goes through the query API and leaves the shared database serving.
async function d1Command(statements) {
  await wranglerRun(["d1", "execute", "DB", "--remote", "--command", statements.map((statement) => `${statement};`).join("\n")]);
}

// ArticleWorkflow builds the key from the untrimmed payload title while D1 keeps the trimmed
// one, so a stray control character at either end changes the archive key.
function keyCandidates(article) {
  const keys = new Set();
  for (const prefix of ["", "\n"]) {
    for (const suffix of ["", "\n"]) {
      keys.add(articleObjectKey({ id: article.id, title: `${prefix}${article.title}${suffix}`, publishedAt: article.published_at }));
    }
  }
  return [...keys];
}

async function readMarkdown(article) {
  for (const key of keyCandidates(article)) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // wrangler puts the key into the URL path as is, so a literal % (e.g. "1.6%") must be escaped.
        const path = `article/${key.replaceAll("%", "%25")}`;
        return (await wranglerRun(["r2", "object", "get", path, "--remote", "--pipe"])).toString("utf8");
      } catch (error) {
        if (/does not exist|not found|10007/i.test(`${error.stderr ?? ""}${error.message}`)) break;
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
    }
  }
  return null;
}

const pending = await d1Query(`
  SELECT id, title, published_at FROM article
  WHERE summary IS NOT NULL
    AND date(published_at, '+8 hours') >= '${from}'
    AND (prompt_version IS NULL OR prompt_version != '${ARTICLE_FEATURE_PROMPT_VERSION}')
  ORDER BY julianday(published_at) DESC, id DESC
  LIMIT ${limit}`);
console.log(`pending articles since ${from}: ${pending.length} (prompt ${ARTICLE_FEATURE_PROMPT_VERSION}, concurrency ${concurrency}${dryRun ? ", dry run" : ""})`);

const labelCounts = new Map();
for (const row of await d1Query("SELECT label, COUNT(*) AS n FROM node GROUP BY label ORDER BY n DESC LIMIT 200")) {
  labelCounts.set(row.label, row.n);
}
const topLabels = () =>
  [...labelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, RECENT_LABEL_LIMIT).map(([label]) => label);

const stats = { done: 0, missing: 0, failed: 0, nodes: 0, claims: 0 };
let buffer = [];
let buffered = 0;
let flushing = Promise.resolve();
let stopping = false;
let writeError = null;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("stopping after in-flight articles; progress is kept (Ctrl-C again to exit now)");
});

// An article counts as done only once its rows are written. A write that still fails after
// retries stops the run, so no further model calls are spent on results that cannot be saved.
function flush() {
  if (buffer.length === 0) return flushing;
  const statements = buffer;
  const count = buffered;
  buffer = [];
  buffered = 0;
  flushing = flushing.then(async () => {
    if (writeError) {
      stats.failed += count;
      return;
    }
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          if (!dryRun) await d1Command(statements);
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        }
      }
      stats.done += count;
    } catch (error) {
      writeError = error;
      stopping = true;
      stats.failed += count;
      console.error(`D1 write failed, stopping: ${String(error.stderr ?? error.message).slice(0, 300)}`);
    }
  });
  return flushing;
}

async function processArticle(article) {
  const markdown = await readMarkdown(article);
  if (markdown === null) {
    stats.missing += 1;
    console.log(`missing archive: ${article.id} ${article.title}`);
    return;
  }
  let features;
  for (let attempt = 1; ; attempt += 1) {
    try {
      features = await extractFeaturesForArticle(credentials, article, markdown, topLabels());
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  for (const node of features.nodes) labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
  stats.nodes += features.nodes.length;
  stats.claims += features.claims.length;
  if (args.out) {
    await appendFile(args.out, `${JSON.stringify({ id: article.id, title: article.title, publishedAt: article.published_at, nodes: features.nodes, claims: features.claims })}\n`);
  }
  buffer.push(...graphReplaceStatements(article.id, features, ARTICLE_FEATURE_PROMPT_VERSION, new Date().toISOString()));
  buffered += 1;
  if (buffered >= FLUSH_EVERY) await flush();
}

let next = 0;
async function worker() {
  while (!stopping) {
    const article = pending[next++];
    if (!article) return;
    try {
      await processArticle(article);
    } catch (error) {
      stats.failed += 1;
      console.error(`failed: ${article.id} ${String(error.message).slice(0, 200)}`);
    }
    const total = Math.min(next, pending.length);
    if (total % 10 === 0) console.log(`${total}/${pending.length} done=${stats.done} missing=${stats.missing} failed=${stats.failed} nodes=${stats.nodes} claims=${stats.claims}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await flush();
console.log(`finished: ${JSON.stringify(stats)}`);
if (writeError) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) fail(`unexpected argument ${argv[index]}`);
    const name = argv[index].slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) parsed[name] = true;
    else { parsed[name] = value; index += 1; }
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
