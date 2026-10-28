import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { infer, validateModel } from "./issuance.mjs";

const [directory, inputFile, requestFile] = process.argv.slice(2);
if (!directory || !inputFile)
  throw new Error("Usage: node online/cli.mjs BUNDLE_DIRECTORY INPUT_JSON");
const manifest = JSON.parse(
  await readFile(resolve(directory, "manifest.json"), "utf8"),
);
const inputBytes = await readFile(inputFile),
  inputs = JSON.parse(inputBytes);
const start = process.cpuUsage();
const request = requestFile ? JSON.parse(await readFile(requestFile, 'utf8')) : {};
const result = await infer(manifest, inputs, async (name) => {
  const entry = manifest.models[name];
  if (!entry) throw new Error(`Missing model ${name}`);
  const bytes = await readFile(resolve(directory, entry.file));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    throw new Error("Model checksum mismatch");
  const model = JSON.parse(bytes);
  validateModel(manifest, model);
  return model;
}, request);
result.online_run.input_sha256 = createHash("sha256")
  .update(inputBytes)
  .digest("hex");
const cpu = process.cpuUsage(start);
await writeFile(
  resolve(directory, "result.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    model_version: manifest.model_version,
    as_of_date: inputs.as_of_date,
    prediction: result.forecast[0]?.coupon_percent,
    cpu_ms: (cpu.user + cpu.system) / 1000,
    output: resolve(directory, "result.json"),
  }),
);
