import { issuanceSnapshot as snapshot } from "../fixtures/issuance.mjs";

function sellSidePayload() {
  return {
    generatedAt: "2026-08-24T03:00:00.000Z",
    periodStart: "2026-08-18",
    periodEnd: "2026-08-24",
    searchQuery: "债券市场",
    maxResults: 50,
    sourceDocuments: 8,
    modelName: "gpt-5.6-luna",
    logicSummary: "资金面判断总体一致，但长端利率方向仍存在分歧。",
    edited: false,
    updatedAt: null,
    views: ["兴业固收", "天风固收", "华源固收", "中信固收"].map((institution, index) => ({
      institution,
      title: `${institution}周报`,
      publishedAt: "2026-08-24",
      stance: index === 2 ? "challenges" : "supports",
      summary: "资金面保持平稳。",
      implication: "发行窗口仍可关注。",
      sourceKey: `2026-08-24/${institution}.md`,
    })),
  };
}

function versions() {
  return [
    {
      runId: snapshot().run_id,
      asOfDate: snapshot().as_of_date,
      generatedAt: snapshot().generated_at,
    },
  ];
}

export const financingModel = { model_status:{model_version:'0123456789abcdef0123',status:'active',reason:'synthetic_test'}, snapshot: snapshot(), sellSide: sellSidePayload(), versions: versions(), conclusion: {verdict:'尽快发行', preferredWindow:'8月24日', narrative:'基础结论', edited:false, updatedAt:null},
  business_metrics: {lcr:{date:'2026-08-21',value_ratio:1.23,historical_percentile:45,sample_count:60},nsfr:{date:'2026-08-21',value_ratio:1.38,historical_percentile:62,sample_count:60},
    funding_gap:{date:'2026-08-21',value_yi:-20,historical_percentile:35,sample_count:60},
    issuer_spread:{date:'2026-08-21',spread_bp:12.5,outstanding_bonds:8,balance_cny:150_000_000_000,historical_percentile:72,sample_count:60}} };
