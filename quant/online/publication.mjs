import { requireActiveModel } from './model-eligibility.mjs';
const resultKeyPattern = /^quant-trial\/runs\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_-]{1,100})\/result\.json$/;

/** Publish only a checksum-verified completed result; PostgreSQL owns the atomic mapping. */
export async function publishArchivedResult(env, key, Client) {
  const match = typeof key === "string" ? resultKeyPattern.exec(key) : null;
  if (!match) throw new Error("Invalid financing model result key");
  const object = await env.ARTIFACTS.get(key);
  if (!object || object.size > 256 * 1024)
    throw new Error("Financing model result missing or oversized");
  const expected = object.customMetadata?.sha256;
  if (!/^[a-f0-9]{64}$/.test(expected ?? ""))
    throw new Error("Financing model result checksum missing");
  const bytes = await object.arrayBuffer();
  const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error("Financing model result checksum mismatch");
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (result.as_of_date !== match[1] || result.online_run?.workflow_id !== match[2]
    || result.online_run?.runtime !== "cloudflare-workflow")
    throw new Error("Financing model result provenance mismatch");

  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  });
  try {
    await client.connect();
    await requireActiveModel(client, result.online_run.model_version);
    const saved = await client.query(
      "SELECT financing_model.publish_online_result($1::jsonb, $2::text) AS run_id",
      [JSON.stringify(result), key],
    );
    if (!saved.rows[0]?.run_id) throw new Error("Financing model publication returned no run");
    return {
      run_id: saved.rows[0].run_id,
      result_key: key,
      model_version: result.online_run.model_version,
      as_of_date: result.as_of_date,
    };
  } finally {
    await client.end();
  }
}
