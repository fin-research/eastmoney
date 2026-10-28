// Upload immutable model objects first; update the activation pointer last.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { requireActiveModel } from "./model-eligibility.mjs";


const directory = resolve(process.argv[2] ?? "../outputs/online");
const manifest = JSON.parse(
  await readFile(join(directory, "manifest.json"), "utf8"),
);
const evidence = JSON.parse(
  await readFile(join(directory, "parity.json"), "utf8"),
);
const hashFile = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
if (
  manifest.feature_version !== "issuance-coupon" ||
  manifest.market_model !== "unified_coupon" ||
  !evidence.snapshotParity ||
  evidence.model_version !== manifest.model_version ||
  evidence.manifest_sha256 !==
    (await hashFile(join(directory, "manifest.json"))) ||
  evidence.input_sha256 !== (await hashFile(join(directory, "inputs.json"))) ||
  evidence.result_sha256 !== (await hashFile(join(directory, "result.json")))
)
  throw new Error("Passing parity evidence for this exact bundle is required");
for (const name of [
  "features.mjs",
  "tree.mjs",
  "issuance.mjs",
  "issuance-features.mjs",
  "sources.json",
  "coupon-model.mjs",
  "coupon-features.mjs",
  "curve-grid.mjs",
  "industry-source.json",
  "input-segments.mjs",
  "raw-quote-context.mjs",
  "segmented-coupon.mjs",
  "model-eligibility.mjs",
]) {
  if (evidence.runtime_sha256?.[name] !== (await hashFile(resolve(name))))
    throw new Error("Runtime changed after parity verification");
}
const wrangler = resolve("node_modules/.bin/wrangler");
function upload(key, file) {
  execFileSync(
    wrangler,
    [
      "r2",
      "object",
      "put",
      `eastmoney/${key}`,
      "--file",
      file,
      "--remote",
      "--content-type",
      "application/json",
    ],
    { stdio: "inherit" },
  );
}
// Validate every file before the first remote mutation.
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required to verify model eligibility");
const eligibilityClient = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15000,query_timeout:30000});
try {
  await eligibilityClient.connect();
  await requireActiveModel(eligibilityClient,manifest.model_version);
} finally {await eligibilityClient.end();}
for (const entry of Object.values(manifest.models)) {
  if (!/^model-(main|\d+)\.json$/.test(entry.file))
    throw new Error("Invalid model path");
  if ((await hashFile(join(directory, entry.file))) !== entry.sha256)
    throw new Error("Model checksum mismatch");
}
const temporary = await mkdtemp(join(tmpdir(), "quant-model-"));
async function immutableUpload(key, file) {
  const local = join(temporary, "existing.json");
  try {
    execFileSync(
      wrangler,
      ["r2", "object", "get", `eastmoney/${key}`, "--file", local, "--remote"],
      { stdio: "pipe" },
    );
  } catch (error) {
    const output = String(error.stdout ?? "") + String(error.stderr ?? "");
    if (!/does not exist|not found|10007|NoSuchKey/i.test(output))
      throw new Error("Cannot verify remote artifact existence");
    upload(key, file);
    return;
  }
  // Serialized maintenance command; a content-derived version is never reused
  // for a changed manifest. Refuse accidental overwrite of a remote artifact.
  const existing = await hashFile(local);
  const desired = await hashFile(file);
  if (existing !== desired)
    throw new Error(`Refusing to overwrite immutable artifact: ${key}`);
}
try {
  for (const entry of Object.values(manifest.models)) {
    const file = join(directory, entry.file),
      data = await readFile(file);
    if (createHash("sha256").update(data).digest("hex") !== entry.sha256)
      throw new Error("Model checksum mismatch");
    await immutableUpload(
      `quant-trial/models/${manifest.model_version}/${entry.file}`,
      file,
    );
  }
  await immutableUpload(
    `quant-trial/models/${manifest.model_version}/manifest.json`,
    join(directory, "manifest.json"),
  );
  if (process.argv.includes("--stage-only")) {
    console.log(JSON.stringify({staged: true, model_version: manifest.model_version, activated: false}));
    process.exitCode = 0;
  } else {
    const pointer = join(temporary, "current.json");
    await writeFile(
      pointer,
      JSON.stringify({
        model_version: manifest.model_version,
        manifest_sha256: evidence.manifest_sha256,
      }),
    );
    upload("quant-trial/models/current.json", pointer);
  }
} finally {
  await rm(temporary, { recursive: true });
}
