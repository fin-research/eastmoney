import {
  addDays,
  buildFeatures,
  calendarFeatures,
  median,
  std,
  validIssues,
} from "./features.mjs";
import { explain, predict } from "./tree.mjs";
import sources from "./sources.json" with { type: "json" };

const round = (x, n) => Number(x.toFixed(n));
const labels = {
  strong_buy: "建议发行",
  neutral: "建议等待",
  wait: "暂缓发行",
};
const zone = { strong_buy: "较优", neutral: "中枢", wait: "较劣" };
export const scenarios = [
  { tenor: 3, bond_type: "证券公司债" },
  { tenor: 5, bond_type: "证券公司债" },
  { tenor: 3, bond_type: "证券公司次级债" },
  { tenor: 5, bond_type: "证券公司次级债" },
].map((x) => ({ ...x, rating: "AAA", issue_size: 30 }));

export function validDate(date) {
  return (
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}

export function validateDataset(name, rows, date) {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`Missing dataset: ${name}`);
  if (
    rows.some(
      (r) =>
        !validDate(r.observation_date) ||
        r.observation_date >= date ||
        (r.published_date &&
          (!validDate(r.published_date) || r.published_date >= date)),
    )
  )
    throw new Error(`Future or invalid data: ${name}`);
  const latest = {};
  for (const row of rows) {
    if (
      row.value == null ||
      row.value === "" ||
      (typeof row.value === "number" && !Number.isFinite(row.value))
    )
      continue;
    if (
      (name === "funding" ||
        (name === "macro" &&
          ["EMM00000012", "EMM00121996", "EMM00634721", "EMM00087086"].includes(
            row.field,
          ))) &&
      Number(row.value) === 0
    )
      continue;
    if (name === "macro" && !row.published_date)
      throw new Error("Missing macro publication date");
    const available = row.published_date || row.observation_date;
    if (!latest[row.field] || available > latest[row.field])
      latest[row.field] = available;
  }
  for (const field of Object.keys(sources[name])) {
    if (!latest[field]) throw new Error(`Missing field: ${name}/${field}`);
    const limit =
      name === "macro"
        ? field === "EMM00000012"
          ? 150
          : 75
        : name === "issue"
          ? 60
          : 14;
    if (latest[field] < addDays(date, -limit))
      throw new Error(`Stale field: ${name}/${field}`);
  }
  return latest;
}

export function validateModel(manifest, model) {
  if (
    model.schema_version !== 1 ||
    model.feature_version !== manifest.feature_version ||
    JSON.stringify(model.feature_names) !==
      JSON.stringify(manifest.feature_names) ||
    model.medians.length !== manifest.feature_names.length ||
    model.medians.some((x) => !Number.isFinite(x)) ||
    !model.trees.length ||
    !model.predictions.length
  )
    throw new Error("Model contract mismatch");
}

export function validateInputs(manifest, inputs) {
  if (
    manifest.schema_version !== 1 ||
    manifest.feature_version !== "online-market-v1" ||
    inputs.schema_version !== 1
  )
    throw new Error("Unsupported contract version");
  const date = inputs.as_of_date;
  if (!validDate(date)) throw new Error("Invalid as-of date");
  if (date < manifest.training_as_of || date > manifest.retrain_after)
    throw new Error("Model outside validity period");
  for (const name of ["funding", "equity", "primary", "macro", "issue"]) {
    validateDataset(name, inputs.datasets[name], date);
  }
}

export function eligibleIssues(rows) {
  const bonds = validIssues(rows);
  const groups = new Map();
  for (const bond of bonds) {
    const key = `${bond.rating}|${bond.tenor}|${bond.bond_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bond);
  }
  const eligible = new Set();
  for (const group of groups.values()) {
    let lower = 0,
      before = 0;
    for (const bond of group) {
      const cutoff = addDays(bond.date, -30);
      while (lower < group.length && group[lower].date < cutoff) lower++;
      while (before < group.length && group[before].date < bond.date) before++;
      if (before - lower >= 3) eligible.add(bond);
    }
  }
  return bonds.filter((b) => eligible.has(b));
}

export function prepare(manifest, inputs) {
  validateInputs(manifest, inputs);
  const market = buildFeatures(inputs);
  const latest = market.filter((r) => r.date < inputs.as_of_date).at(-1);
  if (!latest) throw new Error("No market data before T");
  return { latest, bonds: eligibleIssues(inputs.datasets.issue), market };
}

export function score(
  model,
  market,
  bonds,
  target,
  terms = scenarios[0],
  drivers = false,
) {
  const names = model.feature_names,
    med = Object.fromEntries(names.map((n, i) => [n, model.medians[i]]));
  const peers = bonds
    .filter(
      (b) =>
        b.rating === terms.rating &&
        b.tenor === terms.tenor &&
        b.bond_type === terms.bond_type &&
        b.date < target &&
        b.date >= addDays(target, -30),
    )
    .map((b) => Number(b.spread_to_benchmark));
  const pm = peers.length ? median(peers) : med.peer_spread_median;
  const ps = peers.length
    ? peers.length >= 2
      ? std(peers)
      : 0
    : med.peer_spread_std;
  const fields = {
    ...market,
    tenor_feat: terms.tenor,
    has_option_feat: 0,
    is_subordinated_feat: Number(terms.bond_type === "证券公司次级债"),
    log_issue_size_feat: Math.log1p(terms.issue_size),
    rating_score_feat: 5,
    implied_vs_explicit_feat: 0,
    peer_spread_median: pm,
    peer_spread_std: ps,
    peer_count: peers.length || med.peer_count,
    issuer_frequency_30d: 0,
    tenor_x_credit_spread: terms.tenor * market.credit_spread,
    tenor_x_dr007_pctile: terms.tenor * market.dr007_pctile_60d,
  };
  const vector = names.map((n, i) =>
    Number.isFinite(fields[n]) ? fields[n] : model.medians[i],
  );
  if (vector.some((x) => !Number.isFinite(x)))
    throw new Error("Non-finite model input");
  const pred = predict(model, vector);
  const reference =
    model.groups[`${terms.bond_type}|${terms.tenor}Y`] ?? model.predictions;
  const percentile =
    (reference.filter((p) => p <= pred).length / reference.length) * 100;
  const recommendation =
    percentile <= 100 / 3
      ? "strong_buy"
      : percentile <= 200 / 3
        ? "neutral"
        : "wait";
  return {
    pred_bp: pred,
    percentile,
    recommendation,
    label: labels[recommendation],
    peer: pm,
    vector,
    ...(drivers ? { shap: explain(model, vector) } : {}),
  };
}

export function forecastPlan(asOf, latestDate) {
  const rows = [];
  for (let h = 0; h < 14; h++) {
    const date = addDays(asOf, h);
    if (calendarFeatures(date).day_of_week >= 5) continue;
    let featureDate = addDays(date, -1);
    while (calendarFeatures(featureDate).day_of_week >= 5)
      featureDate = addDays(featureDate, -1);
    if (featureDate < latestDate) featureDate = latestDate;
    rows.push({ date, horizon: h, featureDate });
  }
  return rows;
}

function driverRows(manifest, today) {
  const drivers = manifest.feature_names
    .map((feature, i) => ({
      feature,
      shap: round(today.shap.values[i], 3),
      value: round(today.vector[i], 4),
    }))
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  const included = drivers.filter(
    (d) => !manifest.driver_excluded.includes(d.feature),
  );
  const market_drivers = included
    .slice(0, 5)
    .map((d) => ({
      ...d,
      display_name: manifest.driver_labels[d.feature] ?? d.feature,
      impact: d.shap > 0 ? "推高成本" : "降低成本",
      direction: d.shap > 0 ? "推高成本" : "降低成本",
    }));
  const grouped = manifest.driver_groups.map(([category, display_name]) => {
    const rows = included.filter(
      (d) => manifest.driver_group_by_feature[d.feature] === category,
    );
    return {
      category,
      display_name,
      signed: rows.reduce((a, d) => a + d.shap, 0),
      absolute: rows.reduce((a, d) => a + Math.abs(d.shap), 0),
    };
  });
  const total = grouped.reduce((a, g) => a + g.absolute, 0);
  return {
    market_drivers,
    driver_structure: grouped.map((g) => ({
      category: g.category,
      display_name: g.display_name,
      support_bp: round(-g.signed, 3),
      support_score: round(
        total ? Math.max(0, Math.min(100, 50 - (50 * g.signed) / total)) : 50,
        2,
      ),
      importance_weight: round(total ? g.absolute / total : 0, 6),
    })),
  };
}

export function resultSnapshot(
  manifest,
  asOf,
  latest,
  today,
  products,
  windows,
) {
  const productRows = products.map((s, i) => ({
    display_name: `${scenarios[i].tenor}Y ${i < 2 ? "公募债" : "次级债"}`,
    tenor_years: scenarios[i].tenor,
    bond_type: scenarios[i].bond_type,
    pred_bp: round(s.pred_bp, 2),
    peer_spread_median_bp: round(s.peer, 2),
    historical_percentile: round(s.percentile, 1),
    recommendation: s.recommendation,
    recommendation_label: s.label,
  }));
  const ranked = productRows
    .map((r, i) => i)
    .sort((a, b) => productRows[a].pred_bp - productRows[b].pred_bp);
  const best = productRows[ranked[0]];
  productRows.forEach((r, i) =>
    Object.assign(r, {
      rank: ranked.indexOf(i) + 1,
      is_recommended: i === ranked[0],
      cost_vs_best_bp: round(r.pred_bp - best.pred_bp, 2),
    }),
  );
  const windowRows = windows.map(({ date, score: s }) => ({
    date,
    weekday: ["周一", "周二", "周三", "周四", "周五"][
      calendarFeatures(date).day_of_week
    ],
    pred_bp: round(s.pred_bp, 2),
    percentile: round(s.percentile, 1),
    label: s.label,
  }));
  const center = median(windowRows.map((r) => r.pred_bp));
  for (const row of windowRows) {
    row.savings_bp_vs_window_median = round(row.pred_bp - center, 2);
    row["savings_万元/年"] = round(row.savings_bp_vs_window_median * 30, 1);
  }
  const preferredDates = windowRows
    .toSorted((a, b) => a.pred_bp - b.pred_bp)
    .slice(0, 3)
    .map((r) => r.date)
    .sort();
  const preferredWindow = preferredDates
    .map((d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`)
    .join("、");
  return {
    schema_version: 3,
    run_id: crypto.randomUUID(),
    model_name: "bond_financing_timing_lgbm",
    generated_at: new Date().toISOString(),
    as_of_date: asOf,
    market_data_date: latest.date,
    issue_terms: {
      issue_size_billion_yuan: 30,
      tenor_years: 3,
      rating: "AAA",
      bond_type: "证券公司债",
    },
    prediction: {
      deviation_bp: today.pred_bp,
      peer_spread_median_bp: today.peer,
      historical_percentile: today.percentile,
      recommendation: today.recommendation,
      recommendation_label: today.label,
      window_zone: zone[today.recommendation],
      decision: today.label,
    },
    company_metrics: null,
    ...driverRows(manifest, today),
    product_recommendation: {
      recommended_product: best.display_name,
      recommended_tenor_years: best.tenor_years,
      recommended_bond_type: best.bond_type,
      scenarios: productRows,
    },
    forecast_window: windowRows,
    validation: manifest.validation,
    base_conclusion: {
      verdict: today.label,
      preferred_window: preferredWindow,
      preferred_dates: preferredDates,
      narrative: `模型预测发行利差相对近30日可比债中位数偏离 ${today.pred_bp >= 0 ? "+" : ""}${today.pred_bp.toFixed(2)} bp，处于历史 P${today.percentile.toFixed(0)}。公司业务指标暂无可用快照。未来窗口中相对更优日期为${preferredWindow}。`,
    },
    source_freshness: {
      market_data_date: latest.date,
      company_metrics_date: null,
      subject_spread_date: null,
    },
    online_run: {
      model_version: manifest.model_version,
      feature_version: manifest.feature_version,
      training_as_of: manifest.training_as_of,
      retrain_after: manifest.retrain_after,
      excluded_groups: manifest.excluded_groups,
      runtime: "javascript",
    },
  };
}

export async function infer(manifest, inputs, loadModel) {
  const { latest, bonds } = prepare(manifest, inputs),
    asOf = inputs.as_of_date;
  const main = await loadModel("main");
  const today = score(main, latest, bonds, asOf, scenarios[0], true);
  const products = scenarios.map((terms) =>
    score(main, latest, bonds, asOf, terms),
  );
  const windows = [];
  for (const plan of forecastPlan(asOf, latest.date)) {
    const model = plan.horizon ? await loadModel(String(plan.horizon)) : main;
    const market = plan.horizon
      ? { ...latest, ...calendarFeatures(plan.featureDate) }
      : latest;
    windows.push({
      date: plan.date,
      score: score(model, market, bonds, plan.date),
    });
  }
  return resultSnapshot(manifest, asOf, latest, today, products, windows);
}
