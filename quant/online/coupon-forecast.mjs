import { nextNowcastQuoteDay } from './timing-nowcast.mjs';

export const couponFeatureVersion = 'coupon-forecast-v3';
export const issuerName = '东方财富证券股份有限公司';
export const curveCode = '5781a1ff7651967e0176978d957b7346';
export const bondTypes = ['证券公司债', '证券公司次级债'];
const DAY = 86400000;
const rates = {
  GOV_1Y: 'E1000172', GOV_3Y: 'E1000174', GOV_10Y: 'E1000180', CDB_3Y: 'E1701708', CDB_10Y: 'E1701714',
  AAA_3Y: 'E1000413', DR007: 'E1300004', R007: 'E1704420', SHIBOR_3M: 'E1300079',
};
const primary = ['ISSUE_AMT', 'ISSUE_NUM', 'NET_FINANCE_AMT', 'END_REPAY_AMT', 'RESALE_AMT'];
const fund = {
  EMM00000012: ['GDP不变价同比', 'M'], EMM00121996: ['制造业PMI', 'M'], EMM00008445: ['工业增加值同比', 'M'],
  EMM00641328: ['工业企业利润总额同比', 'M'], EMI00135328: ['社零同比', 'M'], EMM00590832: ['固定资产投资同比', 'M'],
  EMI00120220: ['房地产开发投资同比', 'M'], EMM00053058: ['出口金额同比', 'M'], EMM00072301: ['CPI同比', 'M'],
  EMI01737210: ['核心CPI同比', 'M'], EMM00073348: ['PPI同比', 'M'], EMM01607812: ['GDP平减指数同比', 'M'],
  EMM00087084: ['M1同比', 'M'], EMM00087086: ['M2同比', 'M'], EMM00634721: ['社融存量同比', 'M'], EMM00087129: ['人民币贷款同比', 'M'],
  EMG00000733: ['美国CPI同比', 'M'], EMG00157776: ['美国核心PCE同比', 'M'], EMG00152118: ['美国新增非农', 'M'], EMG00001039: ['美国失业率', 'M'],
  EMI01778636: ['30城商品房成交', 'D'], EMI00227697: ['南华工业品指数', 'D'], EMI01670402: ['水泥价格指数', 'D'],
  EMG00001306: ['美债2Y', 'D'], EMG00001310: ['美债10Y', 'D'], EMG00001435: ['美元指数', 'D'], EMM00618963: ['USD/CNH', 'D'],
  EMI00531920: ['WTI原油', 'D'], EMI00224675: ['黄金', 'D'], EMG00002593: ['标普500', 'D'], EMG00002594: ['纳斯达克', 'D'],
  EMG01582711: ['MSCI新兴市场', 'D'], EMG00002651: ['VIX', 'D'],
  E1715081: ['7D逆回购利率', 'D'], E1300003: ['DR001', 'D'], E1000183: ['30Y国债', 'D'],
};
export const allEdbCodes = [...new Set([...Object.values(rates), ...Object.keys(fund)])].sort();
export const factorCodes = { primary: [...primary, 'WEIGHTED_COST'] };
const rating = { AAA: 3, AAAsti: 3, 'AA+': 2 };
const nodeTolerance = 0.03, fillLimit = 20, historyEvents = 5, pathQuotes = 10;
export const groups = ['利率', '信用', '资金面', '基本面', '一级发行', '二级行情', '发行条款'];
export const products = [3, 5].flatMap(tenor => [['public', '证券公司债', '公募债'], ['sub', '证券公司次级债', '次级债']]
  .map(([kind, bondType, name]) => ({ key: `${tenor}y-${kind}`, tenor, bond_type: bondType, label: `${tenor}年${name}` })));

const finite = value => typeof value === 'number' && Number.isFinite(value);
const ms = date => Date.parse(`${date}T00:00:00Z`);
const NaNv = Number.NaN;
export class Refused extends Error {}

export function couponColumns() {
  const out = [];
  for (const name of Object.keys(rates)) out.push(name, `${name}_chg1`, `${name}_chg5`);
  out.push('SECTOR_chg1', 'SECTOR_chg5', 'SECTOR_slope_3_5', 'credit_spread', 'term_spread_10_1', 'cdb_gov_3y');
  out.push(...primary.map(f => `${f}_5d`), 'WEIGHTED_COST', 'WEIGHTED_COST_chg5');
  out.push('tenor_node', 'subordinated', 'log_amount', 'rating_rank');
  for (const [name, freq] of Object.values(fund)) out.push(name, freq === 'M' ? `${name}·较上期变化` : `${name}·5日变化`);
  out.push('issuer_spread', 'issuer_spread_chg5', 'issuer_term_gap', 'issuer_log_balance', 'issuer_n_bonds');
  return out;
}

export function validateCouponModel(model) {
  const n = model.columns?.length;
  if (model.kind !== 'coupon_huber' || !(n > 0) || new Set(model.columns).size !== n
    || JSON.stringify(model.columns) !== JSON.stringify(couponColumns())
    || ['mean', 'scale', 'coef'].some(k => !Array.isArray(model[k]) || model[k].length !== n || !model[k].every(finite))
    || !model.scale.every(x => x > 0) || !finite(model.intercept)) throw new Error('Invalid coupon model');
}

function curveFrame(rows) {
  const byDate = new Map(), tenors = new Set();
  for (const r of rows) {
    if (!finite(r.yield_pct)) continue;
    if (!byDate.has(r.observation_date)) byDate.set(r.observation_date, new Map());
    byDate.get(r.observation_date).set(r.tenor_years, r.yield_pct);
    tenors.add(r.tenor_years);
  }
  return { byDate, nodes: [...tenors].sort((a, b) => a - b) };
}

function nearestNode(nodes, tenor) {
  let best = NaNv, gap = Infinity;
  for (const node of nodes) if (Math.abs(node - tenor) < gap) { gap = Math.abs(node - tenor); best = node; }
  return gap <= nodeTolerance + 1e-12 ? best : null;
}

export function quoteDays(inputs) {
  const asOf = inputs.as_of_date;
  const days = inputs.datasets.curve_days.map(r => r.observation_date).filter(d => d < asOf).sort();
  if (days.length < 30 || days.at(-1) !== inputs.required_source_date) throw new Refused('Stale sector curve');
  return days;
}

function firstSeries(rows, field) {
  const map = new Map();
  for (const r of rows) if (r.field === field && finite(r.value) && !map.has(r.observation_date)) map.set(r.observation_date, r.value);
  return map;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b), n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

export function issuerHistory(inputs, days) {
  const frame = curveFrame([...inputs.datasets.curve, ...inputs.datasets.event_curves]);
  const rows = [];
  for (const e of inputs.datasets.issuer_events) {
    let q = null;
    for (let i = days.length - 1; i >= 0; i--) if (days[i] < e.tender_date) { q = days[i]; break; }
    if (!q || !frame.byDate.has(q)) continue;
    const node = nearestNode(frame.nodes, e.tenor);
    const anchor = node === null ? undefined : frame.byDate.get(q).get(node);
    if (node === null || node < 1 || !(e.bond_rating in rating) || !finite(anchor)) continue;
    rows.push({ bond_code: e.bond_code, bond_type: e.bond_type, tender: e.tender_date, label: e.tender_announcement_date ?? e.tender_date,
      dev: (e.coupon - anchor) * 100, amount: e.amount, rating: e.bond_rating });
  }
  if (!rows.length) throw new Refused('No issuer history');
  return rows.sort((a, b) => a.tender < b.tender ? -1 : a.tender > b.tender ? 1 : a.bond_code < b.bond_code ? -1 : a.bond_code > b.bond_code ? 1 : 0);
}

export function issuerTerms(history, asOf, bondType) {
  const known = history.filter(h => ms(h.label) + DAY < ms(asOf));
  const usable = known.filter(h => h.bond_type === bondType).slice(-historyEvents);
  if (usable.length < 2) throw new Refused(`Fewer than two prior ${bondType} issues`);
  return [median(usable.map(h => h.dev)), median(usable.map(h => h.amount)), rating[known.at(-1).rating], usable.length];
}

function fillForward(days, values) {
  const out = []; let last = NaNv, gap = 0;
  for (const d of days) {
    const v = values.get(d);
    if (finite(v)) { last = v; gap = 0; out.push(v); }
    else { gap++; out.push(finite(last) && gap <= fillLimit ? last : NaNv); }
  }
  return out;
}

function issuerValuation(inputs, days, frame) {
  const obs = inputs.datasets.issuer_bonds;
  if (!obs.length) throw new Refused('No issuer bond valuations');
  const bad = new Set();
  for (const o of obs) if (!finite(o.bal) || (o.bal > 0 && (!finite(o.y) || !finite(o.term)))) bad.add(o.date);
  const interp = (date, t) => {
    const row = frame.byDate.get(date);
    const xs = [...row.keys()].sort((a, b) => a - b);
    if (t < xs[0] || t > xs.at(-1)) return NaNv;
    for (let i = 0; i < xs.length; i++) {
      if (t === xs[i]) return row.get(xs[i]);
      if (t < xs[i]) { const x0 = xs[i - 1], x1 = xs[i], y0 = row.get(x0), y1 = row.get(x1); return y0 + (y1 - y0) * (t - x0) / (x1 - x0); }
    }
    return row.get(xs.at(-1));
  };
  const agg = new Map();
  for (const o of obs) {
    if (!(o.bal > 0) || !finite(o.y) || !finite(o.term) || !frame.byDate.has(o.date)) continue;
    const curve = interp(o.date, o.term);
    if (!finite(curve)) continue;
    const a = agg.get(o.date) ?? { wSp: 0, wTerm: 0, bal: 0, n: 0 };
    a.wSp += (o.y - curve) * 100 * o.bal; a.wTerm += o.term * o.bal; a.bal += o.bal; a.n += 1;
    agg.set(o.date, a);
  }
  const series = { spread: new Map(), term: new Map(), bal: new Map(), n: new Map() };
  for (const [d, a] of agg) {
    if (!bad.has(d)) { series.spread.set(d, a.wSp / a.bal); series.term.set(d, a.wTerm / a.bal); }
    series.bal.set(d, a.bal); series.n.set(d, a.n);
  }
  return Object.fromEntries(Object.entries(series).map(([k, v]) => [k, fillForward(days, v)]));
}

export function couponFeatures(inputs, product, catchUp, stats, days) {
  const p = days.length - 1, q = days[p], ds = inputs.datasets;
  const frame = curveFrame(ds.curve);
  const node = nearestNode(frame.nodes, product.tenor);
  const anchor = node === null ? undefined : frame.byDate.get(q)?.get(node);
  if (!finite(anchor)) throw new Refused('Missing sector anchor');
  const at = (date, n) => frame.byDate.get(date)?.get(n);
  const out = {};
  for (const [name, code] of Object.entries(rates)) {
    const s = firstSeries(ds.edb, code), v0 = s.get(q) ?? NaNv;
    out[name] = v0;
    for (const k of [1, 5]) out[`${name}_chg${k}`] = (v0 - (s.get(days[p - k]) ?? NaNv)) * 100;
  }
  for (const k of [1, 5]) out[`SECTOR_chg${k}`] = (anchor - at(days[p - k], node)) * 100;
  out.SECTOR_slope_3_5 = (at(q, 5) - at(q, 3)) * 100;
  out.credit_spread = (at(q, 3) - out.GOV_3Y) * 100;
  out.term_spread_10_1 = (out.GOV_10Y - out.GOV_1Y) * 100;
  out.cdb_gov_3y = (out.CDB_3Y - out.GOV_3Y) * 100;
  const quant = Object.fromEntries([...primary, 'WEIGHTED_COST'].map(f => [f, firstSeries(ds.quant_input, f)]));
  const natural = (f, date, back) => quant[f].get(new Date(ms(date) - back * DAY).toISOString().slice(0, 10)) ?? NaNv;
  for (const f of primary) {
    let sum = 0;
    for (let b = 0; b < 5; b++) sum += natural(f, q, b);
    out[`${f}_5d`] = sum;
  }
  out.WEIGHTED_COST = quant.WEIGHTED_COST.get(q) ?? NaNv;
  out.WEIGHTED_COST_chg5 = (out.WEIGHTED_COST - (quant.WEIGHTED_COST.get(days[p - 5]) ?? NaNv)) * 100;
  const [median_, amount, ratingRank] = stats;
  out.tenor_node = node;
  out.subordinated = product.bond_type === '证券公司次级债' ? 1 : 0;
  out.log_amount = Math.log(Math.max(amount, 1e-6));
  out.rating_rank = ratingRank;
  out.catch_up_hat = catchUp;
  for (const [code, [name, freq]] of Object.entries(fund)) {
    if (freq === 'M') {
      const seen = new Map();
      for (const r of ds.edb) if (r.field === code && finite(r.value) && !seen.has(r.observation_date)) seen.set(r.observation_date, r);
      const avail = [...seen.values()].filter(r => r.published_date).map(r => [r.published_date, r.value])
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
      const usable = avail.filter(([d]) => d <= q).map(([, v]) => v);
      out[name] = usable.length ? usable.at(-1) : NaNv;
      out[`${name}·较上期变化`] = usable.length >= 2 ? usable.at(-1) - usable.at(-2) : NaNv;
    } else {
      const s = [...firstSeries(ds.edb, code)].sort((a, b) => a[0] < b[0] ? -1 : 1);
      const level = date => {
        let last = null;
        for (const [d, v] of s) { if (d <= date) last = [d, v]; else break; }
        return last && ms(date) - ms(last[0]) <= 10 * DAY ? last[1] : NaNv;
      };
      out[name] = level(q);
      out[`${name}·5日变化`] = level(q) - level(days[p - 5]);
    }
  }
  const val = issuerValuation(inputs, days, frame);
  out.issuer_spread = val.spread[p];
  out.issuer_spread_chg5 = val.spread[p] - val.spread[p - 5];
  out.issuer_term_gap = val.term[p] - node;
  out.issuer_log_balance = val.bal[p] > 0 ? Math.log(val.bal[p]) : NaNv;
  out.issuer_n_bonds = val.n[p];
  return { values: out, anchor, node, median: median_ };
}

export function featureGroup(name) {
  if (/^(GOV_|CDB_|美债|30Y国债)/.test(name) || name === 'term_spread_10_1' || name === 'cdb_gov_3y') return '利率';
  if (/^(AAA_3Y|SECTOR_)/.test(name) || name === 'credit_spread') return '信用';
  if (/^(DR007|R007|SHIBOR|7D逆回购|DR001)/.test(name)) return '资金面';
  if (/^(ISSUE_|NET_FINANCE|END_REPAY|RESALE|WEIGHTED_COST)/.test(name)) return '一级发行';
  if (/^(issuer_|catch_up_hat)/.test(name)) return '二级行情';
  if (['tenor_node', 'subordinated', 'log_amount', 'rating_rank'].includes(name)) return '发行条款';
  return '基本面';
}

const rateNames = { GOV_1Y: '1Y国债', GOV_3Y: '3Y国债', GOV_10Y: '10Y国债', CDB_3Y: '3Y国开债', CDB_10Y: '10Y国开债', AAA_3Y: '3Y AAA企业债', DR007: 'DR007', R007: 'R007', SHIBOR_3M: 'SHIBOR 3M' };
const otherNames = {
  SECTOR_slope_3_5: '券商债3Y-5Y曲线斜率', credit_spread: '3Y券商债-国债利差', term_spread_10_1: '国债10Y-1Y期限利差', cdb_gov_3y: '3Y国开债-国债利差',
  WEIGHTED_COST: '一级加权融资成本', WEIGHTED_COST_chg5: '一级加权融资成本5日变动', tenor_node: '发行期限', subordinated: '次级债', log_amount: '发行规模',
  rating_rank: '主体评级', catch_up_hat: '券商债曲线短期走势预测', issuer_spread: '发行人存量债估值利差', issuer_spread_chg5: '发行人存量债估值利差5日变动',
  issuer_term_gap: '发行人存量债期限差', issuer_log_balance: '发行人存量债余额', issuer_n_bonds: '发行人存量债只数',
  ISSUE_AMT_5d: '5日一级发行额', ISSUE_NUM_5d: '5日一级发行只数', NET_FINANCE_AMT_5d: '5日一级净融资额', END_REPAY_AMT_5d: '5日到期偿还额', RESALE_AMT_5d: '5日回售额',
};
export function featureLabel(name) {
  if (name in otherNames) return otherNames[name];
  for (const [key, label] of Object.entries(rateNames)) {
    if (name === key) return ['DR007', 'R007', 'SHIBOR_3M'].includes(key) ? label : `${label}收益率`;
    if (name.startsWith(`${key}_chg`)) return `${label}${name.split('chg').at(-1)}日变动`;
  }
  if (name.startsWith('SECTOR_chg')) return `券商债曲线${name.split('chg').at(-1)}日变动`;
  return name;
}

function productForecast(manifest, model, inputs, timing, days, history, product) {
  const stats = issuerTerms(history, inputs.as_of_date, product.bond_type);
  const { values, anchor, median: median_ } = couponFeatures(inputs, product, timing.catch_up_bp, stats, days);
  const x = model.columns.map(c => values[c]);
  if (!x.every(finite)) throw new Refused(`Incomplete coupon inputs: ${model.columns.filter((_, i) => !finite(x[i])).slice(0, 5).join(',')}`);
  const terms = x.map((v, i) => (v - model.mean[i]) / model.scale[i] * model.coef[i]);
  const residual = terms.reduce((s, t) => s + t, model.intercept);
  const catchUp = timing.catch_up_bp;
  const deviation = median_ + catchUp + residual, coupon = anchor + deviation / 100;
  const base = anchor * 100 + median_ + model.intercept;
  const detail = model.columns.map((c, i) => ({ feature: c, label: featureLabel(c), group: featureGroup(c), value: x[i], contribution_bp: terms[i] }));
  detail.push({ feature: 'catch_up_hat', label: featureLabel('catch_up_hat'), group: '二级行情', value: catchUp, contribution_bp: catchUp });
  const sums = Object.fromEntries(groups.map(g => [g, 0]));
  for (const d of detail) sums[d.group] += d.contribution_bp;
  if (Math.abs(base + Object.values(sums).reduce((s, v) => s + v, 0) - coupon * 100) > 1e-6) throw new Error('Contributions do not reconcile');
  const path = [];
  for (let h = 0; h < pathQuotes; h++) {
    const day = nextNowcastQuoteDay(inputs.required_source_date, manifest.calendar, 1 + h);
    if (!day) break;
    path.push({ date: day, coupon_percent: coupon + timing.wait_bp * Math.min(h, 3) / 3 / 100 });
  }
  return { key: product.key, label: product.label, tenor: product.tenor, bond_type: product.bond_type, anchor_pct: anchor,
    issuer_median_bp: median_, intercept_bp: model.intercept, base_coupon_bp: base, deviation_bp: deviation, coupon_pct: coupon,
    n_prior: stats[3], planned_amount_yi: stats[1], groups: groups.map(g => ({ group: g, net_bp: sums[g] })), contributions: detail, path };
}

export function inferCoupon(manifest, model, inputs, timing) {
  if (manifest.feature_version !== couponFeatureVersion) throw new Error('Invalid coupon manifest');
  validateCouponModel(model);
  const days = quoteDays(inputs), history = issuerHistory(inputs, days);
  const list = products.map(product => productForecast(manifest, model, inputs, timing, days, history, product));
  return {
    schema_version: couponFeatureVersion, run_id: crypto.randomUUID(), generated_at: new Date().toISOString(),
    as_of_date: inputs.as_of_date, market_source_date: inputs.required_source_date, model_version: manifest.model_version,
    issuer: inputs.issuer, training_label_cutoff: manifest.training_label_cutoff,
    timing: { catch_up_bp: timing.catch_up_bp, wait_bp: timing.wait_bp, action: timing.action },
    products: list, validation: manifest.validation,
    base_conclusion: { verdict: timing.action, preferred_window: '', narrative: `${list[0].label}预测发行利率${list[0].coupon_pct.toFixed(2)}%。` },
    online_run: { model_version: manifest.model_version, feature_version: couponFeatureVersion,
      training_as_of: manifest.training_as_of, retrain_after: manifest.retrain_after },
  };
}
