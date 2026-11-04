import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wrangler = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const articleColumns = [
  "id",
  "news_id",
  "title",
  "published_at",
  "created_at",
  "updated_at",
  "link",
  "author",
  "summary",
  "importance",
  "prompt_version",
];
const nodeColumns = ["article_id", "ordinal", "label", "kind", "fact", "impact"];
const claimColumns = [
  "article_id",
  "ordinal",
  "cause",
  "cause_move",
  "effect",
  "effect_move",
  "basis",
  "mechanism",
];
const bootstrapArticleLimit = 100;

await runWrangler(["d1", "migrations", "apply", "DB", "--local"]);

const [localState] = await queryWrangler(
  ["d1", "execute", "DB", "--local"],
  `SELECT
     (SELECT MAX(updated_at) FROM article) AS article_updated_at,
     (SELECT COUNT(*) FROM article) AS article_count`,
);
const articleCutoff = optionalString(localState?.article_updated_at);
const bootstrap = Number(localState?.article_count ?? 0) === 0;
const articleWhere = articleCutoff
  ? `WHERE a.updated_at > ${sqlLiteral(articleCutoff)}`
  : `WHERE a.id IN (
       SELECT candidate.id
       FROM article candidate
       WHERE candidate.summary IS NOT NULL
         AND candidate.importance IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM node candidate_node
           WHERE candidate_node.article_id = candidate.id
         )
       ORDER BY candidate.updated_at DESC, candidate.id DESC
       LIMIT ${bootstrapArticleLimit}
     )`;
let articles = [];
let nodes = [];
let claims = [];
let remoteUnavailable = false;
try {
  [articles, nodes, claims] = await Promise.all([
    queryWrangler(
      ["d1", "execute", "DB", "--remote"],
      `SELECT ${articleColumns.map((column) => `a.${column}`).join(", ")}
       FROM article a
       ${articleWhere}
       ORDER BY a.updated_at ASC, a.id ASC`,
    ),
    queryWrangler(
      ["d1", "execute", "DB", "--remote"],
      `SELECT ${nodeColumns.map((column) => `k.${column}`).join(", ")}
       FROM node k
       INNER JOIN article a ON a.id = k.article_id
       ${articleWhere}
       ORDER BY a.updated_at ASC, k.article_id ASC, k.ordinal ASC`,
    ),
    queryWrangler(
      ["d1", "execute", "DB", "--remote"],
      `SELECT ${claimColumns.map((column) => `k.${column}`).join(", ")}
       FROM claim k
       INNER JOIN article a ON a.id = k.article_id
       ${articleWhere}
       ORDER BY a.updated_at ASC, k.article_id ASC, k.ordinal ASC`,
    ),
  ]);
} catch (error) {
  if (bootstrap) throw error;
  remoteUnavailable = true;
  console.warn(
    `远程 D1 增量同步暂不可用，沿用本地开发副本（${shortError(error)}）。`,
  );
}

if (articles.length > 0) {
  const statements = ["PRAGMA defer_foreign_keys=TRUE;"];
  if (articles.length > 0) {
    statements.push(upsertSql("article", articleColumns, articles, ["id"]));
    const ids = articles.map((article) => sqlLiteral(article.id)).join(", ");
    statements.push(`DELETE FROM claim WHERE article_id IN (${ids});`);
    statements.push(`DELETE FROM node WHERE article_id IN (${ids});`);
    if (nodes.length > 0) {
      statements.push(insertSql("node", nodeColumns, nodes));
    }
    if (claims.length > 0) {
      statements.push(insertSql("claim", claimColumns, claims));
    }
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "eastmoney-d1-sync-"));
  const incrementalSqlPath = join(temporaryDirectory, "incremental.sql");
  try {
    await writeFile(incrementalSqlPath, statements.join("\n"));
    await runWrangler([
      "d1",
      "execute",
      "DB",
      "--local",
      "--file",
      incrementalSqlPath,
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (!remoteUnavailable) {
  const modeLabel = bootstrap ? "有限初始化" : "增量同步";
  console.log(
    `${modeLabel}远程 D1：${articles.length} 篇文章、${nodes.length} 个节点、${claims.length} 条因果主张。`,
  );
}

function optionalString(value) {
  return typeof value === "string" && value ? value : null;
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("fetch failed") ? "fetch failed" : message.split("\n")[0];
}

function insertSql(table, columns, rows) {
  const columnList = columns.map(quoteIdentifier).join(", ");
  const values = rows
    .map(
      (row) =>
        `(${columns.map((column) => sqlLiteral(row[column])).join(", ")})`,
    )
    .join(",\n");
  return `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES\n${values};`;
}

function upsertSql(table, columns, rows, conflictColumns) {
  const updateColumns = columns.filter(
    (column) => !conflictColumns.includes(column),
  );
  return `${insertSql(table, columns, rows).slice(0, -1)}
ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET
${updateColumns
  .map(
    (column) =>
      `  ${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`,
  )
  .join(",\n")};`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("D1 row contains a non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function queryWrangler(baseArguments, sql) {
  const output = await runWrangler([
    ...baseArguments,
    "--json",
    "--command",
    sql,
  ]);
  const payload = JSON.parse(output);
  if (!Array.isArray(payload) || payload.some((item) => item.success !== true)) {
    throw new Error("Wrangler D1 query did not return a successful result");
  }
  return payload.flatMap((item) => item.results ?? []);
}

function runWrangler(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(wrangler, arguments_, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      const detail = [errorOutput.trim(), output.trim()]
        .filter(Boolean)
        .join("\n");
      rejectPromise(
        new Error(
          `Wrangler 命令失败（退出码 ${code ?? "unknown"}）${detail ? `：\n${detail}` : ""}`,
        ),
      );
    });
  });
}
