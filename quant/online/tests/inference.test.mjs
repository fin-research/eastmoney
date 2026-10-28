import test from "node:test";
import assert from "node:assert/strict";
import { predict, explain } from "../tree.mjs";
import { eligibleIssues, forecastPlan, validateInputs } from "../inference.mjs";
import { pivot, macroFeatures } from "../features.mjs";
import sources from "../sources.json" with { type: "json" };

test("exact tree contributions include baseline and repeated feature splits", () => {
  const model = {
    trees: [
      {
        split_feature: 0,
        threshold: 1,
        decision_type: "<=",
        default_left: true,
        internal_count: 4,
        left_child: {
          split_feature: 0,
          threshold: 0,
          decision_type: "<=",
          default_left: true,
          internal_count: 2,
          left_child: { leaf_value: 2, leaf_count: 1 },
          right_child: { leaf_value: 4, leaf_count: 1 },
        },
        right_child: { leaf_value: 8, leaf_count: 2 },
      },
    ],
  };
  for (const [x, expected] of [
    [-1, 2],
    [0.5, 4],
    [2, 8],
    [null, 2],
  ]) {
    assert.equal(predict(model, [x, 999]), expected);
    const s = explain(model, [x, 999]);
    assert.equal(s.expected, 5.5);
    assert.equal(s.values[0], expected - 5.5);
    assert.equal(s.values[1], 0);
  }
});

test("macro data becomes available only at publication, with legitimate zero CPI", () => {
  const rows = pivot("macro", [
    {
      field: "EMM00072301",
      observation_date: "2026-08-01",
      published_date: "2026-09-09",
      value: 0,
    },
    {
      field: "EMM00121996",
      observation_date: "2026-08-01",
      published_date: "2026-08-31",
      value: 50.1,
    },
  ]);
  const f = macroFeatures(rows, ["2026-09-08", "2026-09-09"]);
  assert.ok(Number.isNaN(f[0].CPI));
  assert.equal(f[1].CPI, 0);
  assert.equal(f[0].PMI, 50.1);
});

test("input guard rejects look-ahead, expired models and missing data", () => {
  const manifest = {
    schema_version: 1,
    feature_version: "online-market-v1",
    training_as_of: "2026-09-01",
    retrain_after: "2027-03-01",
  };
  const datasets = Object.fromEntries(
    Object.entries(sources).map(([k, mapping]) => [
      k,
      Object.keys(mapping).map((field) => ({
        field,
        value: 1,
        observation_date: "2026-09-17",
        published_date: "2026-09-17",
      })),
    ]),
  );
  validateInputs(manifest, {
    schema_version: 1,
    as_of_date: "2026-09-18",
    datasets,
  });
  assert.throws(
    () =>
      validateInputs(manifest, {
        schema_version: 1,
        as_of_date: "2026-09-17",
        datasets,
      }),
    /Future/,
  );
  assert.throws(
    () =>
      validateInputs(manifest, {
        schema_version: 1,
        as_of_date: "2027-04-01",
        datasets,
      }),
    /validity/,
  );
  assert.throws(
    () =>
      validateInputs(manifest, {
        schema_version: 1,
        as_of_date: "2026-02-30",
        datasets,
      }),
    /Invalid/,
  );
  const incomplete = structuredClone(datasets);
  incomplete.funding = incomplete.funding.filter((r) => r.field !== "E1300004");
  assert.throws(
    () =>
      validateInputs(manifest, {
        schema_version: 1,
        as_of_date: "2026-09-18",
        datasets: incomplete,
      }),
    /Missing field/,
  );
  const stale = structuredClone(datasets);
  stale.funding[0].observation_date = stale.funding[0].published_date =
    "2026-08-01";
  assert.throws(
    () =>
      validateInputs(manifest, {
        schema_version: 1,
        as_of_date: "2026-09-18",
        datasets: stale,
      }),
    /Stale field/,
  );
});

test("same-day issues are excluded from peer history", () => {
  const data = [];
  const fields = {
    ISSUER_RATING: "AAA",
    BOND_EXPIRE_YEAR: "3年",
    ISSUERATE_REFERENCE: 2,
    ACTUAL_ISSUE_SCALE: 5,
    BOND_TYPE: "证券公司债",
    ISSUECREDITSPREAD: 10,
  };
  for (let i = 0; i < 5; i++)
    for (const [field, value] of Object.entries(fields))
      data.push({
        field,
        value,
        entity_key: String(i),
        observation_date: i === 4 ? "2026-09-02" : "2026-09-01",
      });
  assert.equal(eligibleIssues(data).length, 1);
  assert.equal(eligibleIssues(data)[0].bond_code, "4");
});

test("future windows keep T-1 weekday calendar and direct horizons", () => {
  const plan = forecastPlan("2026-09-18", "2026-09-17");
  assert.deepEqual(plan[0], {
    date: "2026-09-18",
    horizon: 0,
    featureDate: "2026-09-17",
  });
  assert.deepEqual(plan[1], {
    date: "2026-09-21",
    horizon: 3,
    featureDate: "2026-09-18",
  });
  assert.equal(plan.length, 10);
});
