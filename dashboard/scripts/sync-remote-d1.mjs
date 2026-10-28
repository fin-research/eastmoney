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
const keywordColumns = [
  "article_id",
  "ordinal",
  "topic",
  "fact",
  "interpretation",
  "impact",
];
const snapshotColumns = [
  "snapshot_id",
  "input_fingerprint",
  "generated_at",
  "model",
  "scope",
  "payload",
];
const bootstrapArticleLimit = 100;
const bootstrapSnapshotLimit = 100;

await runWrangler(["d1", "migrations", "apply", "DB", "--local"]);

const [localState] = await queryWrangler(
  ["d1", "execute", "DB", "--local"],
  `SELECT
     (SELECT MAX(updated_at) FROM article) AS article_updated_at,
     (SELECT COUNT(*) FROM article) AS article_count,
     (SELECT MAX(generated_at) FROM hotspot_snapshot) AS snapshot_generated_at`,
);
const articleCutoff = optionalString(localState?.article_updated_at);
const snapshotCutoff = optionalString(localState?.snapshot_generated_at);
const bootstrap = Number(localState?.article_count ?? 0) === 0;
const articleWhere = articleCutoff
  ? `WHERE a.updated_at > ${sqlLiteral(articleCutoff)}`
  : `WHERE a.id IN (
       SELECT candidate.id
       FROM article candidate
       WHERE candidate.summary IS NOT NULL
         AND candidate.importance IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM keyword candidate_keyword
           WHERE candidate_keyword.article_id = candidate.id
         )
       ORDER BY candidate.updated_at DESC, candidate.id DESC
       LIMIT ${bootstrapArticleLimit}
     )`;
const snapshotWhere = snapshotCutoff
  ? `WHERE generated_at > ${sqlLiteral(snapshotCutoff)}`
  : `WHERE snapshot_id IN (
       SELECT candidate_snapshot.snapshot_id
       FROM hotspot_snapshot candidate_snapshot
       ORDER BY candidate_snapshot.generated_at DESC, candidate_snapshot.snapshot_id DESC
       LIMIT ${bootstrapSnapshotLimit}
     )`;

let articles = [];
let keywords = [];
let snapshots = [];
let remoteUnavailable = false;
try {
  [articles, keywords, snapshots] = await Promise.all([
    queryWrangler(
      ["d1", "execute", "DB", "--remote"],
      `SELECT ${articleColumns.map((column) => `a.${column}`).join(", ")}
       FROM article a
       ${articleWhere}
       ORDER BY a.updated_at ASC, a.id ASC`,
    ),
    queryWrangler(
      ["d1", "execute", "DB", "--remote"],
      `SELECT ${keywordColumns.map((column) => `k.${column}`).join(", ")}
       FROM keyword k
       INNER JOIN article a ON a.id = k.article_id
       ${articleWhere}
       ORDER BY a.updated_at ASC, k.article_id ASC, k.ordinal ASC`,
    ),
    queryWrangler(
      ["d1", "execute", "DB", "--remote"],
      `SELECT ${snapshotColumns.join(", ")}
       FROM hotspot_snapshot
       ${snapshotWhere}
       ORDER BY generated_at ASC, snapshot_id ASC`,
    ),
  ]);
} catch (error) {
  if (bootstrap) throw error;
  remoteUnavailable = true;
  console.warn(
    `远程 D1 增量同步暂不可用，沿用本地开发副本（${shortError(error)}）。`,
  );
}

if (articles.length > 0 || snapshots.length > 0) {
  const statements = ["PRAGMA defer_foreign_keys=TRUE;"];
  if (articles.length > 0) {
    statements.push(upsertSql("article", articleColumns, articles, ["id"]));
    statements.push(
      `DELETE FROM keyword WHERE article_id IN (${articles
        .map((article) => sqlLiteral(article.id))
        .join(", ")});`,
    );
    if (keywords.length > 0) {
      statements.push(insertSql("keyword", keywordColumns, keywords));
    }
  }
  if (snapshots.length > 0) {
    statements.push(
      upsertSql("hotspot_snapshot", snapshotColumns, snapshots, ["snapshot_id"]),
    );
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
    `${modeLabel}远程 D1：${articles.length} 篇文章、${keywords.length} 条关键词、${snapshots.length} 条热点快照。`,
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
