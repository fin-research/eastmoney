import sources from "./sources.json" with { type: "json" };

const finite = Number.isFinite;
const num = (value) => (value == null ? NaN : Number(value));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const median = (xs) => {
  const sorted = xs.filter(finite).toSorted((a, b) => a - b),
    n = sorted.length;
  return n ? (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2 : NaN;
};
export const std = (xs) => {
  if (xs.length < 2) return NaN;
  const avg = mean(xs);
  return Math.sqrt(
    xs.reduce((a, b) => a + (b - avg) ** 2, 0) / (xs.length - 1),
  );
};
const diff = (xs, n) => xs.map((v, i) => v - xs[i - n]);
const zip = (a, b, op) => a.map((x, i) => op(x, b[i]));
const sub = (a, b) => zip(a, b, (x, y) => x - y);
const roll = (xs, n, fn, min = n) =>
  xs.map((_, i) => {
    const window = xs.slice(Math.max(0, i - n + 1), i + 1).filter(finite);
    return window.length >= min ? fn(window, xs[i]) : NaN;
  });
const percentile = (xs, current) =>
  finite(current) ? xs.filter((x) => x <= current).length / xs.length : NaN;
const minmax = (xs, current) =>
  (current - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) + 1e-8);

export function pivot(group, rows) {
  const mapping = sources[group],
    dates = new Map(),
    periods = {};
  if (group === "macro") {
    if (rows.some((r) => !r.published_date))
      throw new Error("Missing macro publication date");
    rows = rows.toSorted(
      (a, b) =>
        a.published_date.localeCompare(b.published_date) ||
        a.observation_date.localeCompare(b.observation_date),
    );
  }
  for (const row of rows) {
    const field = mapping[row.field];
    if (!field) continue;
    if (group === "macro") {
      if (row.observation_date < (periods[field] ?? "")) continue;
      periods[field] = row.observation_date;
    }
    const date = [row.observation_date, row.published_date ?? ""].sort().at(-1);
    const key = group === "issue" ? `${date}|${row.entity_key}` : date;
    const item = dates.get(key) ?? { date, bond_code: row.entity_key };
    item[field] = row.value;
    dates.set(key, item);
  }
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function series(rows, key, zerosMissing = false) {
  return rows.map((row) =>
    zerosMissing && num(row[key]) === 0 ? NaN : num(row[key]),
  );
}
function forward(xs) {
  let last = NaN;
  return xs.map((x) => {
    if (finite(x)) last = x;
    return last;
  });
}
function frame(rows, columns) {
  return rows.map((r, i) =>
    Object.fromEntries([
      ["date", r.date],
      ...Object.entries(columns).map(([k, vs]) => [k, vs[i]]),
    ]),
  );
}

export function fundingFeatures(rows) {
  const d = series(rows, "DR007", true),
    r = series(rows, "R007", true);
  const g1 = series(rows, "GOV_1Y", true),
    g3 = series(rows, "GOV_3Y", true),
    g10 = series(rows, "GOV_10Y", true);
  const aaa = series(rows, "AAA_3Y", true),
    term = sub(g10, g1),
    credit = sub(aaa, g3);
  const f = {
    dr007: d,
    dr007_vs_policy: sub(d, forward(series(rows, "reverse_repo_rate", true))),
    r007_dr007_spread: sub(r, d),
    shibor_3m: series(rows, "SHIBOR_3M", true),
    gov_10y: g10,
    term_spread: term,
    dr007_ma5: roll(d, 5, mean),
    dr007_ma20: roll(d, 20, mean),
    dr007_chg_5d: diff(d, 5),
    dr007_chg_20d: diff(d, 20),
    dr007_vol_5d: roll(d, 5, std),
    dr007_vol_20d: roll(d, 20, std),
    term_spread_chg_5d: diff(term, 5),
    term_spread_chg_20d: diff(term, 20),
    credit_spread: credit,
    credit_spread_chg_5d: diff(credit, 5),
    credit_spread_chg_20d: diff(credit, 20),
    credit_spread_pctile_60d: roll(credit, 60, percentile, 20),
    credit_spread_vol_20d: roll(credit, 20, std),
    cdb_gov_spread: sub(series(rows, "CDB_10Y", true), g10),
    yield_vol_5d: roll(aaa, 5, std),
    curve_curvature: g3.map((x, i) => 2 * x - g1[i] - g10[i]),
    short_term_spread: sub(g3, g1),
    gov_10y_chg_20d: diff(g10, 20),
    dr007_pctile_60d: roll(d, 60, minmax, 20),
    term_spread_pctile_60d: roll(term, 60, minmax, 20),
    gov_10y_pctile_60d: roll(g10, 60, minmax, 20),
  };
  f.dr007_vs_ma5_dev = sub(d, f.dr007_ma5);
  f.dr007_vol_trend = zip(
    f.dr007_vol_5d,
    f.dr007_vol_20d,
    (a, b) => a / (b + 1e-8),
  );
  f.term_spread_slope_chg = sub(f.term_spread_chg_5d, f.term_spread_chg_20d);
  return frame(rows, f);
}

export function equityFeatures(rows) {
  const c = series(rows, "csi300_close"),
    v = series(rows, "vix_close");
  const returns = (n) => c.map((x, i) => x / c[i - n] - 1);
  return frame(rows, {
    csi300_ret_5d: returns(5),
    csi300_ret_20d: returns(20),
    csi300_ret_60d: returns(60),
    csi300_vol_20d: roll(returns(1), 20, std),
    turnover_rate: series(rows, "all_a_turnover_rate"),
    equity_bond_spread: series(rows, "equity_bond_spread"),
    vix: v,
    vix_chg_5d: diff(v, 5),
    vix_pctile_60d: roll(v, 60, percentile, 20),
  });
}

export function primaryFeatures(rows) {
  rows = rows.filter((r) =>
    ["issue_size", "issue_count", "weighted_cost"].every((k) =>
      finite(num(r[k])),
    ),
  );
  const size = series(rows, "issue_size"),
    count = series(rows, "issue_count"),
    cost = series(rows, "weighted_cost");
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const f = {
    weighted_cost: cost,
    weighted_cost_chg_5d: diff(cost, 5),
    weighted_cost_chg_20d: diff(cost, 20),
  };
  const avg = roll(size, 252, mean),
    sd = roll(size, 252, std);
  for (const n of [5, 20]) {
    f[`supply_${n}d`] = roll(size, n, sum);
    f[`issue_count_${n}d`] = roll(count, n, sum);
    f[`supply_${n}d_zscore`] = f[`supply_${n}d`].map(
      (v, i) => (v - avg[i] * n) / (sd[i] * Math.sqrt(n) + 1e-8),
    );
  }
  const net = series(rows, "net_financing").map((x) => (finite(x) ? x : 0));
  const maturity = series(rows, "maturity_amount").map((x) =>
    finite(x) ? x : 0,
  );
  const redemption = series(rows, "redemption_amount").map((x) =>
    finite(x) ? x : 0,
  );
  const netMean = roll(net, 252, mean),
    netStd = roll(net, 252, std);
  f.net_financing_5d = roll(net, 5, sum);
  f.net_financing_20d = roll(net, 20, sum);
  f.net_financing_zscore = f.net_financing_5d.map(
    (v, i) => (v - netMean[i] * 5) / (netStd[i] * Math.sqrt(5) + 1e-8),
  );
  f.maturity_wall_20d = roll(maturity, 20, sum);
  f.redemption_pressure = roll(
    zip(redemption, maturity, (a, b) => a + b),
    20,
    sum,
  );
  return frame(rows, f);
}

export function align(rows, dates) {
  let position = 0;
  const latest = {};
  return dates.map((date) => {
    while (position < rows.length && rows[position].date <= date) {
      for (const [key, value] of Object.entries(rows[position]))
        if (finite(value)) latest[key] = value;
      position++;
    }
    return { ...latest, date };
  });
}

export function macroFeatures(rows, dates) {
  const cleaned = rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        ["GDP", "PMI", "SOCIAL_FINANCE", "M2"].includes(k) && num(v) === 0
          ? NaN
          : v,
      ]),
    ),
  );
  const aligned = align(cleaned, dates),
    f = {};
  for (const name of ["GDP", "CPI", "PPI", "PMI", "SOCIAL_FINANCE", "M2"])
    f[name] = series(aligned, name);
  for (const name of ["CPI", "PPI", "PMI", "M2", "SOCIAL_FINANCE"]) {
    f[`${name}_mom`] = diff(f[name], 1);
    f[`${name}_3m_chg`] = diff(f[name], 3);
  }
  f.pmi_above_50 = f.PMI.map((x) => (finite(x) ? Number(x > 50) : NaN));
  for (const name of ["PMI", "M2"]) {
    const fresh = new Set(
      cleaned.filter((r) => finite(num(r[name]))).map((r) => r.date),
    );
    let age = -1;
    f[`${name}_staleness`] = dates.map((date) => {
      age = fresh.has(date) ? 0 : age + 1;
      return age;
    });
  }
  return frame(aligned, f);
}

export function addDays(date, days) {
  return new Date(Date.parse(date) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function calendarFeatures(date) {
  const dt = new Date(date),
    y = dt.getUTCFullYear(),
    m = dt.getUTCMonth() + 1,
    d = dt.getUTCDate();
  return {
    day_of_week: (dt.getUTCDay() + 6) % 7,
    month: m,
    is_month_end: Number(d >= 25),
    is_quarter_end: Number(m % 3 === 0 && d >= 20),
    is_year_end: Number(m === 12 && d >= 15),
    days_to_month_end: new Date(Date.UTC(y, m, 0)).getUTCDate() - d,
    days_to_quarter_end:
      (Date.UTC(y, Math.ceil(m / 3) * 3, 0) - dt.getTime()) / 86400000,
    is_mlf_week: Number(d >= 13 && d <= 17),
  };
}

export function combineFeatures(groups) {
  const dates = groups.funding.map((r) => r.date);
  const aligned = Object.values(groups).map((rows) => align(rows, dates));
  let eqN = 0,
    bondN = 0,
    eqMean = 0,
    eqM2 = 0,
    bondMean = 0,
    bondM2 = 0;
  return dates.map((date, i) => {
    const r = Object.assign(
      {},
      ...aligned.map((rows) => rows[i]),
      calendarFeatures(date),
    );
    r.funding_credit_stress =
      r.dr007_pctile_60d - 0.5 + (r.credit_spread_pctile_60d - 0.5);
    // Both start at the 20-observation lag. Maintain independent Welford
    // states below to match pandas expanding(skipna=True).
    if (finite(r.csi300_ret_20d)) {
      eqN++;
      const de = r.csi300_ret_20d - eqMean;
      eqMean += de / eqN;
      eqM2 += de * (r.csi300_ret_20d - eqMean);
    }
    if (finite(r.gov_10y_chg_20d)) {
      bondN++;
      const db = r.gov_10y_chg_20d - bondMean;
      bondMean += db / bondN;
      bondM2 += db * (r.gov_10y_chg_20d - bondMean);
    }
    r.risk_appetite =
      eqN >= 20 && bondN >= 20
        ? (r.csi300_ret_20d / Math.max(Math.sqrt(eqM2 / (eqN - 1)), 1e-8) +
            r.gov_10y_chg_20d /
              Math.max(Math.sqrt(bondM2 / (bondN - 1)), 1e-8)) /
          2
        : NaN;
    r.supply_funding_pressure =
      ((finite(r.supply_20d_zscore) ? r.supply_20d_zscore : 0) +
        (finite(r.dr007_pctile_60d) ? (r.dr007_pctile_60d - 0.5) * 2 : 0)) /
      2;
    return r;
  });
}

export function buildFeatures(inputs) {
  const data = inputs.datasets;
  const funding = fundingFeatures(pivot("funding", data.funding));
  return combineFeatures({
    funding,
    equity: equityFeatures(pivot("equity", data.equity)),
    primary: primaryFeatures(pivot("primary", data.primary)),
    macro: macroFeatures(
      pivot("macro", data.macro),
      funding.map((r) => r.date),
    ),
  });
}

export function validIssues(rows) {
  return pivot("issue", rows)
    .map((r) => ({
      ...r,
      tenor: Number(String(r.tenor).match(/\d+(?:\.\d+)?/)?.[0]),
      issue_date: r.date,
    }))
    .filter(
      (r) =>
        ["证券公司债", "证券公司次级债"].includes(r.bond_type) &&
        r.rating &&
        ["tenor", "coupon", "issue_size", "spread_to_benchmark"].every((k) =>
          finite(num(r[k])),
        ),
    );
}
