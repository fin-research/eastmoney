import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { creditMigrationPlan } from "./credit-migration-plan.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for credit migrations");
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = path.join(repositoryRoot, "credit-migrations");
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();
const finalize = process.argv.includes('--finalize');
// The additive stage is safe for the running old Worker. Finalization removes
// its write entry point and therefore requires verified new production traffic.
const client = new Client({
  connectionString,
  application_name: "eastmoney-credit-migration",
});

try {
  await client.connect();
  await client.query("CREATE SCHEMA IF NOT EXISTS credit");
  await client.query(`
    CREATE TABLE IF NOT EXISTS credit.schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended('eastmoney-credit-migrations', 0))",
  );
  const applied = await client.query("SELECT name FROM credit.schema_migration");
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const runnableNames = creditMigrationPlan(migrationNames, appliedNames, finalize);
  const newlyApplied = [];
  for (const name of runnableNames) {
    if (appliedNames.has(name)) continue;
    const sql = await readFile(path.join(migrationDirectory, name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO credit.schema_migration (name) VALUES ($1)",
        [name],
      );
      await client.query("COMMIT");
      newlyApplied.push(name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.log(
    JSON.stringify(
      {
        database: "neondb",
        schema: "credit",
        applied: newlyApplied,
        alreadyApplied: migrationNames.filter((name) => appliedNames.has(name)),
        deferred: migrationNames.filter(name => !runnableNames.includes(name) && !appliedNames.has(name)),
      },
      null,
      2,
    ),
  );
} finally {
  await client
    .query(
      "SELECT pg_advisory_unlock(hashtextextended('eastmoney-credit-migrations', 0))",
    )
    .catch(() => undefined);
  await client.end().catch(() => undefined);
}
