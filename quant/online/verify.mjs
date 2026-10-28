import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { issuanceFeatures } from "./issuance-features.mjs";
import { couponPrediction, couponExplanation } from "./coupon-model.mjs";
import { couponContext, couponFeature } from "./coupon-features.mjs";


const directory = process.argv[2] ?? "outputs/online";
const read = async (name) =>
  JSON.parse(await readFile(resolve(directory, name), "utf8"));
const inputs = await read("inputs.json"),
  expectedFeatures = await read("python-features.json");
const actualFeatures = issuanceFeatures(inputs).features;
let featureChecks = 0,
  predictionChecks = 0,
  shapChecks = 0,
  maxPredictionError = 0,
  maxShapError = 0;
function close(a, b, message, tolerance = 1e-8) {
  if (a == null && !Number.isFinite(b)) return;
  assert.ok(
    Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a)),
    `${message}: expected ${a}, actual ${b}`,
  );
}
assert.equal(actualFeatures.length, expectedFeatures.length);
for (let i = 0; i < expectedFeatures.length; i++) {
  const expected = expectedFeatures[i],
    actual = actualFeatures[i];
  assert.equal(actual.date, expected.date.slice(0, 10));
  for (const [key, value] of Object.entries(expected)) {
    if (key === "date") continue;
    close(value, actual[key], `feature ${actual.date}/${key}`);
    featureChecks++;
  }
}
const requestFixtures=await read("python-request-features.json");
const parityModel=await read('model-main.json');
const context=couponContext(inputs,inputs.issuance_scope??'all',null,['tenor','tenor_shape'].includes(parityModel.market_layer?.mode),['quote_static','quote_history','quote_pca','quote_product'].includes(parityModel.candidate.feature_set));
for(let i=0;i<requestFixtures.requests.length;i++) {
  const actual=couponFeature(context,requestFixtures.requests[i]);
  for(const [name,value] of Object.entries(requestFixtures.features[i])) {
    if(typeof value==='string')assert.equal(actual[name],value,`request ${i}/${name}`);
    else close(value,actual[name],`request ${i}/${name}`);
    featureChecks++;
  }
}
const fixtures = await read("python-predictions.json");
for (const [name, fixture] of Object.entries(fixtures)) {
  const model = await read(`model-${name}.json`);
  for (let i = 0; i < fixture.vectors.length; i++) {
    const x = fixture.vectors[i],
      prediction = couponPrediction(model, x, fixture.anchors[i]),
      shap = couponExplanation(model, x, fixture.anchors[i]);
    close(fixture.predictions[i], prediction, `prediction ${name}/${i}`);
    predictionChecks++;
    maxPredictionError = Math.max(
      maxPredictionError,
      Math.abs(fixture.predictions[i] - prediction),
    );
    const contributions = [...shap.values, shap.expected];
    contributions.forEach((v, j) => {
      close(fixture.contributions[i][j], v, `SHAP ${name}/${i}/${j}`);
      shapChecks++;
      maxShapError = Math.max(
        maxShapError,
        Math.abs(v - fixture.contributions[i][j]),
      );
    });
    close(
      prediction,
      contributions.reduce((a, b) => a + b, 0),
      `SHAP additivity ${name}/${i}`,
    );
  }
}
const python = await read("python-result.json"),
  js = await read("result.json");
function compare(expected, actual, path = "") {
  if (typeof expected === "number") return close(expected, actual, path, 1e-7);
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, path);
    expected.forEach((v, i) => compare(v, actual[i], `${path}/${i}`));
    return;
  }
  if (expected && typeof expected === "object") {
    for (const [k, v] of Object.entries(expected)) {
      if (["run_id", "generated_at"].includes(k)) continue;
      compare(v, actual[k], `${path}/${k}`);
    }
    return;
  }
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(expected)) expected = expected.slice(0,10);
  assert.equal(actual, expected, path);
}
const businessFields = ["schema_version", "as_of_date", "deadline", "window_days", "market_source_date", "market_model", "terms", "issue_size_yi", "waiting_cost_bp_day", "decision", "forecast", "product_scenarios", "market_forecast", "explanation", "validation", "publication"];
for (const field of businessFields) compare(python[field], js[field], field);
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(resolve(directory, file)))
    .digest("hex");
const manifest = await read("manifest.json");
assert.equal(manifest.feature_version, 'issuance-coupon');
for (const entry of Object.values(manifest.models))
  assert.equal(await digest(entry.file), entry.sha256, "model checksum");
assert.equal(js.online_run.model_version, manifest.model_version);
const runtimeHashes = Object.fromEntries(
  await Promise.all(
    ["features.mjs", "tree.mjs", "issuance.mjs", "issuance-features.mjs", "sources.json", "coupon-model.mjs", "coupon-features.mjs", "curve-grid.mjs", "industry-source.json", "input-segments.mjs", "raw-quote-context.mjs", "segmented-coupon.mjs", "model-eligibility.mjs"].map(
      async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(new URL(name, import.meta.url)))
          .digest("hex"),
      ],
    ),
  ),
);
const evidence = {
  model_version: manifest.model_version,
  manifest_sha256: await digest("manifest.json"),
  input_sha256: await digest("inputs.json"),
  result_sha256: await digest("result.json"),
  runtime_sha256: runtimeHashes,
  featureChecks,
  predictionChecks,
  shapChecks,
  maxPredictionError,
  maxShapError,
  snapshotParity: true,
  businessFields,
};
await writeFile(
  resolve(directory, "parity.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence));
