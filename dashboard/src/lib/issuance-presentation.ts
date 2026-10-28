import type { IssuanceSnapshot } from './issuance-model';

export type IssuanceDecisionLabel = '尽快发行' | '等待' | '暂缓发行';

/** Labels are presentation of the published decision, not a second model. */
export function issuanceDecisionLabel(action: string): IssuanceDecisionLabel | null {
  if (action === '可按资金计划发行' || action === '尽快发行') return '尽快发行';
  if (action === '可择机等待' || action === '等待') return '等待';
  if (action === '暂缓发行') return '暂缓发行';
  return null;
}

/** Display the published coupon window; preserve separately edited human text. */
export function issuanceDecisionNarrative(snapshot: IssuanceSnapshot): string | null {
  if(!['尽快发行','等待'].includes(snapshot.decision.action))return null;
  const first=snapshot.forecast[0];
  if(first?.coupon_percent==null)return '当前没有可用的发行利率预测。';
  const windows=snapshot.decision.low_rate_windows.map(row=>row.start===row.end?row.start:`${row.start}至${row.end}`).join('、');
  const best=snapshot.forecast.find(row=>row.date===snapshot.decision.lowest_expected_cost_date);
  return `首个可发行日预计票面${first.coupon_percent.toFixed(2)}%；预测较低区间为${windows}。${best?.coupon_percent==null?'':`最低日${best.date}预计票面${best.coupon_percent.toFixed(2)}%。`}${snapshot.decision.action==='尽快发行'?'当前已处于较低区间，可按资金计划发行。':'可结合资金需求等待较低区间。'}`;
}

export type ShapGroup = { display_name: string; absolute_bp: number; net_bp: number };
const groups = ['利率', '信用', '资金', '宏观', '一级发行', '二级成交'] as const;
type MarketGroup = typeof groups[number];
type MarketFeature = { name: string; group: MarketGroup };
/** Explicit market registry: issuer, terms, calendar and quality metadata stay in the API only. */
export const issuanceMarketFeatures: Record<string, MarketFeature> = {};
function register(group: MarketGroup, names: Record<string, string>) {
  for (const [feature, name] of Object.entries(names)) issuanceMarketFeatures[feature] = { name, group };
}
register('资金', {
  dr007:'存款类机构7天回购利率', dr007_vs_policy:'资金与政策利率差', r007_dr007_spread:'银行间与存款类回购利差',
  shibor_3m:'上海银行间3个月拆借利率', dr007_ma5:'7天回购利率·5日均值', dr007_ma20:'7天回购利率·20日均值',
  dr007_chg_5d:'7天回购利率·5日变化', dr007_chg_20d:'7天回购利率·20日变化',
  dr007_vol_5d:'7天回购利率·5日波动', dr007_vol_20d:'7天回购利率·20日波动',
  dr007_pctile_60d:'7天回购利率·60日分位', dr007_vs_ma5_dev:'7天回购利率·5日偏离',
  dr007_vol_trend:'7天回购利率波动趋势', funding_credit_stress:'资金与信用压力',
});
register('利率', {
  gov_10y:'10年国债收益率', known_treasury_bp:'同期限国债收益率', term_spread:'期限利差',
  term_spread_chg_5d:'期限利差·5日变化', term_spread_chg_20d:'期限利差·20日变化',
  term_spread_pctile_60d:'期限利差·60日分位', term_spread_slope_chg:'期限利差斜率变化',
  gov_10y_chg_20d:'10年国债·20日变化', gov_10y_pctile_60d:'10年国债·60日分位',
  cdb_gov_spread:'国开与国债利差', curve_curvature:'曲线曲率', short_term_spread:'短端期限利差',
});
register('信用', {
  credit_spread:'信用利差', credit_spread_chg_5d:'信用利差·5日变化', credit_spread_chg_20d:'信用利差·20日变化',
  credit_spread_pctile_60d:'信用利差·60日分位', credit_spread_vol_20d:'信用利差·20日波动',
  yield_vol_5d:'券商债收益率·5日波动', industry_aaa_tenor_bp:'同期限券商行业收益率',
  industry_aaa_minus_treasury_bp:'券商行业与国债利差',
});
for (const [key, title] of Object.entries({gov_1y:'1年国债',gov_3y:'3年国债',gov_10y:'10年国债',aaa_3y:'3年最高评级券商债'})) {
  const group = key === 'aaa_3y' ? '信用' : '利率';
  register(group, {[`rate_${key}_level`]:`${title}收益率`});
  for (const lag of [1,5,20,60]) register(group, {[`rate_${key}_change_${lag}`]:`${title}变化`});
  for (const period of [20,60]) register(group, {[`rate_${key}_deviation_${period}`]:`${title}偏离`});
  register(group, {[`rate_${key}_volatility_20`]:`${title}波动率`});
}
for (const [key, title] of Object.entries({GDP:'国内生产总值',CPI:'居民消费价格',PPI:'工业生产者价格',PMI:'制造业采购经理指数',SOCIAL_FINANCE:'社融',M2:'广义货币'})) {
  for (const [part, label] of Object.entries({level:'水平',change_1m:'1月变化',change_3m:'3月变化'})) register('宏观', {[`macro_${key}_${part}`]:`${title}·${label}`});
}
register('一级发行', {
  weighted_cost:'一级加权融资成本', weighted_cost_chg_5d:'一级融资成本·5日变化', weighted_cost_chg_20d:'一级融资成本·20日变化',
  net_financing_zscore:'净融资标准分', maturity_wall_20d:'到期偿还·20日', redemption_pressure:'偿付压力',
  supply_funding_pressure:'发行与资金压力', peer_premium_mean_bp:'同业发行平均溢价', peer_premium_latest_bp:'同业最近发行溢价',
  peer_weighted_premium_bp:'同业发行加权溢价', peer_weighted_latest_bp:'同业最近加权发行溢价',
  peer_industry_basis_bp:'同业发行与行业利差', peer_industry_basis_latest_bp:'同业最近发行与行业利差',
});
for (const period of [5,20]) register('一级发行', {
  [`supply_${period}d`]:`发行额·${period}日`, [`supply_${period}d_zscore`]:`发行额·${period}日标准分`,
  [`issue_count_${period}d`]:`发行只数·${period}日`, [`net_financing_${period}d`]:`净融资额·${period}日`,
});
register('二级成交', {
  bond_volume_20d_avg:'债券成交量·20日均值', bond_volume_chg_5d:'债券成交量·5日变化',
  bond_volume_pctile_60d:'债券成交量·60日分位', credit_bond_volume_ratio:'信用债成交比',
  credit_volume_chg_5d:'信用债成交量·5日变化', rate_credit_volume_ratio:'利率与信用成交比',
});
export function issuanceFeatureName(feature: string): string {
  const quote = /^(?:quote_h(1|14|30)_)?(sector|issuer)_quote_lag_(\d+)_bp$/.exec(feature);
  if (quote) return `${quote[1] ? `提前${quote[1]}日×` : ''}${quote[2] === 'sector' ? '行业' : '发行人'}报价·${Number(quote[3]) === 0 ? '最新' : `前${quote[3]}个报价日`}`;
  const horizon = /^quote_h(1|14|30)$/.exec(feature);
  if (horizon) return `预测提前${horizon[1]}日`;
  const category = /^(issuer|rating|bond_type|placement_type)__(\d+)$/.exec(feature);
  if (category) return `${({issuer:'发行人', rating:'评级', bond_type:'债券品种', placement_type:'发行方式'} as Record<string,string>)[category[1]!]}编码${category[2]}`;
  const term = ({tenor:'发行期限',issue_size:'发行规模'} as Record<string,string>)[feature];
  return term ?? issuanceMarketFeatures[feature]?.name ?? `未登记列：${feature}`;
}
function shapGroup(feature: string): MarketGroup | undefined {
  return issuanceMarketFeatures[feature]?.group;
}
function isObservedMarketFeature(row: NonNullable<IssuanceSnapshot['explanation']>['features'][number]) {
  return shapGroup(row.feature) !== undefined && row.value !== null && Number.isFinite(row.value)
    && Number.isFinite(row.shap_bp) && row.shap_bp !== 0;
}

/** Aggregate observed market SHAP contributions; the bar chart shows the top individual features. */
export function groupIssuanceShap(features: NonNullable<IssuanceSnapshot['explanation']>['features']): ShapGroup[] {
  const totals = new Map<string, ShapGroup>();
  for (const feature of features) {
    if (!isObservedMarketFeature(feature)) continue;
    const name = shapGroup(feature.feature)!;
    const group = totals.get(name) ?? { display_name: name, absolute_bp: 0, net_bp: 0 };
    group.net_bp += feature.shap_bp;
    totals.set(name, group);
  }
  return groups.flatMap(name => totals.has(name) ? [{...totals.get(name)!, absolute_bp:Math.abs(totals.get(name)!.net_bp)}] : []);
}

/** Keep real macro, issuance and trading contributors visible beside the top bars. */
export function selectIssuanceShapDrivers(features: NonNullable<IssuanceSnapshot['explanation']>['features']) {
  const ranked = features.filter(isObservedMarketFeature)
    .sort((left, right) => Math.abs(right.shap_bp) - Math.abs(left.shap_bp));
  const selected = new Map(ranked.slice(0, 8).map(row => [row.feature, row]));
  for (const group of ['宏观', '一级发行', '二级成交']) {
    const representative = ranked.find(row => shapGroup(row.feature) === group);
    if (representative) selected.set(representative.feature, representative);
  }
  return [...selected.values()].sort((left, right) => Math.abs(right.shap_bp) - Math.abs(left.shap_bp));
}


/** The MLP attribution includes every encoded column, including imputed and zero inputs. */
export function mlpContributionSource(feature: string): string {
  if (feature === 'known_treasury_bp') return '国债收益率';
  if (/^(quote_h(?:1|14|30)_)?sector_quote_lag_\d+_bp$/.test(feature)) return '行业报价';
  if (/^(quote_h(?:1|14|30)_)?issuer_quote_lag_\d+_bp$/.test(feature)) return '发行人报价';
  if (/^issuer__\d+$/.test(feature)) return '发行人身份';
  if (/^rating__\d+$/.test(feature)) return '信用评级';
  if (/^(bond_type|placement_type)__\d+$/.test(feature) || ['tenor','issue_size'].includes(feature)) return '发行条款';
  if (/^quote_h(?:1|14|30)$/.test(feature)) return '预测提前期';
  return `未登记列：${feature}`;
}

export function groupMlpContributions(features: NonNullable<IssuanceSnapshot['explanation']>['features']): ShapGroup[] {
  const totals = new Map<string, number>();
  for (const row of features) {
    if (!Number.isFinite(row.shap_bp)) continue;
    const name = mlpContributionSource(row.feature);
    totals.set(name, (totals.get(name) ?? 0) + row.shap_bp);
  }
  return [...totals].map(([display_name, net_bp]) => ({display_name, net_bp, absolute_bp: Math.abs(net_bp)}))
    .sort((left, right) => right.absolute_bp - left.absolute_bp);
}
