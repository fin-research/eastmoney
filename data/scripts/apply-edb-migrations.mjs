import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const connectionString =
  process.env.DATABASE_URL ??
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required",
  );
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = path.join(repositoryRoot, "edb-migrations");
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();
const client = new Client({
  connectionString,
  application_name: "eastmoney-edb-migration",
});

try {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.edb_schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended('eastmoney-edb-migrations', 0))",
  );
  const applied = await client.query(
    "SELECT name FROM public.edb_schema_migration",
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
        "INSERT INTO public.edb_schema_migration (name) VALUES ($1)",
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
        schema: "public",
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
      "SELECT pg_advisory_unlock(hashtextextended('eastmoney-edb-migrations', 0))",
    )
    .catch(() => undefined);
  await client.end().catch(() => undefined);
}
