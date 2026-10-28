import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for financing model migrations");
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = path.join(
  repositoryRoot,
  "financing-model-migrations",
);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();
const client = new Client({
  connectionString,
  application_name: "eastmoney-financing-model-migration",
});

try {
  await client.connect();
  await client.query("CREATE SCHEMA IF NOT EXISTS financing_model");
  await client.query(`
    CREATE TABLE IF NOT EXISTS financing_model.schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended('eastmoney-financing-model-migrations', 0))",
  );
  const applied = await client.query(
    "SELECT name FROM financing_model.schema_migration",
  );
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const newlyApplied = [];
  for (const name of migrationNames) {
    if (appliedNames.has(name)) continue;
    const sql = await readFile(path.join(migrationDirectory, name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO financing_model.schema_migration (name) VALUES ($1)",
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
        schema: "financing_model",
        applied: newlyApplied,
        alreadyApplied: migrationNames.filter((name) => appliedNames.has(name)),
      },
      null,
      2,
    ),
  );
} finally {
  await client
    .query(
      "SELECT pg_advisory_unlock(hashtextextended('eastmoney-financing-model-migrations', 0))",
    )
    .catch(() => undefined);
  await client.end().catch(() => undefined);
}
