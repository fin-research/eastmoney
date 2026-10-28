import { z } from "zod";

const nullableNumber = z.number().finite().nullable();

export const financingModelSnapshotSchema = z
  .object({
    schema_version: z.number().int().positive(),
    run_id: z.string().uuid(),
    model_name: z.string().min(1),
    generated_at: z.string().min(1),
    as_of_date: z.string().date(),
    market_data_date: z.string().date(),
    online_run: z.object({
      model_version: z.string().regex(/^[a-f0-9]{20}$/),
      feature_version: z.literal("online-market-v1"),
      training_as_of: z.string().date(),
      retrain_after: z.string().date(),
      excluded_groups: z.array(z.string()),
      runtime: z.literal("cloudflare-workflow"),
    }).strict().nullable().optional(),
    issue_terms: z
      .object({
        issue_size_billion_yuan: z.number().positive(),
        tenor_years: z.number().positive(),
        rating: z.string().min(1),
        bond_type: z.string().min(1),
      })
      .strict(),
    prediction: z
      .object({
        deviation_bp: z.number().finite(),
        peer_spread_median_bp: z.number().finite(),
        historical_percentile: z.number().min(0).max(100),
        recommendation: z.enum(["strong_buy", "neutral", "wait"]),
        recommendation_label: z.string().min(1),
        window_zone: z.enum(["较优", "中枢", "较劣"]),
        decision: z.string().min(1),
      })
      .strict(),
    company_metrics: z
      .object({
        date: z.string().date(),
        ef_lcr: nullableNumber,
        ef_nsfr: nullableNumber,
        ef_lcr_pctile_60d: nullableNumber,
        ef_nsfr_pctile_60d: nullableNumber,
        ef_funding_gap: nullableNumber,
        ef_margin_zscore_60d: nullableNumber,
        ef_funding_pressure: nullableNumber,
        ef_subject_spread_bp: nullableNumber,
        ef_subject_spread_pctile: nullableNumber,
        ef_subject_spread_date: z.string().date().nullable(),
        composite_score: nullableNumber,
        readiness_label: z.string(),
        interpretation: z.string(),
      })
      .strict()
      .nullable(),
    market_drivers: z.array(
      z
        .object({
          feature: z.string().min(1),
          display_name: z.string().min(1),
          shap: z.number().finite(),
          value: z.number().finite(),
          direction: z.string().optional(),
          impact: z.enum(["推高成本", "降低成本"]),
        })
        .strict(),
    ),
    driver_structure: z.array(
      z
        .object({
          category: z.string().min(1),
          display_name: z.string().min(1),
          support_score: z.number().min(0).max(100),
          support_bp: z.number().finite(),
          importance_weight: z.number().min(0).max(1),
        })
        .strict(),
    ),
    product_recommendation: z
      .object({
        recommended_product: z.string().min(1),
        recommended_tenor_years: z.number().positive(),
        recommended_bond_type: z.string().min(1),
        scenarios: z.array(
          z
            .object({
              display_name: z.string().min(1),
              tenor_years: z.number().positive(),
              bond_type: z.string().min(1),
              pred_bp: z.number().finite(),
              peer_spread_median_bp: z.number().finite(),
              historical_percentile: z.number().min(0).max(100),
              recommendation: z.enum(["strong_buy", "neutral", "wait"]),
              recommendation_label: z.string().min(1),
              rank: z.number().int().min(1).max(4),
              cost_vs_best_bp: z.number().nonnegative(),
              is_recommended: z.boolean(),
            })
            .strict(),
        ).length(4),
      })
      .strict()
      .nullable(),
    forecast_window: z.array(
      z
        .object({
          date: z.string().date(),
          weekday: z.string().min(1),
          percentile: z.number().min(0).max(100),
          label: z.string().min(1),
          pred_bp: z.number().finite(),
          savings_bp_vs_window_median: z.number().finite(),
          "savings_万元/年": z.number().finite(),
        })
        .strict(),
    ),
    validation: z
      .object({
        tscv: z
          .object({
            folds: z.number().int().positive(),
            validation_samples: z.number().int().nonnegative(),
            sample_count: z.number().int().positive().nullable(),
            sample_start_date: z.string().date().nullable(),
            sample_end_date: z.string().date().nullable(),
            rmse: z.number().finite(),
            mae: nullableNumber,
            ic: z.number().finite(),
            best_iter_median: z.number().int().positive(),
            best_iters: z.array(z.number().int().positive()),
          })
          .strict(),
        timing_value: z
          .object({
            n_total: z.number().int().nonnegative(),
            n_recommended: z.number().int().nonnegative(),
            recommended_share: nullableNumber,
            cost_saving_bp: z.number().finite(),
            recommended_mean_bp: z.number().finite(),
            baseline_mean_bp: z.number().finite(),
            win_rate: z.number().min(0).max(1),
            ic: z.number().finite(),
            group_means: z.array(z.number().finite()),
            monotonic: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    base_conclusion: z
      .object({
        verdict: z.string().min(1).max(120),
        preferred_window: z.string().max(160),
        narrative: z.string().min(1).max(4000),
        preferred_dates: z.array(z.string().date()),
      })
      .strict(),
    source_freshness: z
      .object({
        market_data_date: z.string().date(),
        company_metrics_date: z.string().date().nullable(),
        subject_spread_date: z.string().date().nullable(),
      })
      .strict(),
  })
  .strict();

export const conclusionSchema = z
  .object({
    verdict: z.string().trim().min(1).max(120),
    preferredWindow: z.string().trim().max(160),
    narrative: z.string().trim().min(1).max(4000),
    edited: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .strict();

export const conclusionUpdateSchema = z
  .object({
    runId: z.string().uuid(),
    verdict: z.string().trim().min(1).max(120),
    preferredWindow: z.string().trim().max(160),
    narrative: z.string().trim().min(1).max(4000),
  })
  .strict();

export const timingDecisionInputSchema = z
  .object({
    runId: z.string().uuid(),
    decisionAction: z.string().trim().min(1).max(1000),
    outcome: z.string().trim().max(2000),
  })
  .strict();

export const timingDecisionRecordSchema = z
  .object({
    runId: z.string().uuid(),
    decisionDate: z.string().date(),
    historicalPercentile: z.number().min(0).max(100).nullable(),
    recommendation: z.enum(["strong_buy", "neutral", "wait"]).nullable(),
    recommendationLabel: z.string().min(1),
    decisionAction: z.string().min(1).max(1000),
    outcome: z.string().max(2000),
    updatedAt: z.string().min(1),
  })
  .strict();

export const timingDecisionHistorySchema = z.array(timingDecisionRecordSchema);

const sellSideViewSchema = z
  .object({
    institution: z.string().min(1).max(80),
    title: z.string().min(1).max(300),
    publishedAt: z.string().date(),
    stance: z.enum(["supports", "mixed", "challenges"]),
    summary: z.string().min(1).max(1200),
    implication: z.string().min(1).max(800),
    sourceKey: z.string().min(1).max(500),
  })
  .strict();

const sellSidePayloadSchemaV2 = z
  .object({
    generatedAt: z.string().min(1),
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    searchQuery: z.string().min(1),
    maxResults: z.literal(50),
    sourceDocuments: z.number().int().nonnegative(),
    modelName: z.string().min(1),
    logicSummary: z.string().trim().min(1).max(4000),
    edited: z.boolean().default(false),
    updatedAt: z.string().min(1).nullable().default(null),
    views: z.array(sellSideViewSchema).min(3).max(5),
  })
  .strict();

const legacySellSidePayloadSchema = z
  .object({
    generatedAt: z.string().min(1),
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    searchQuery: z.string().min(1),
    maxResults: z.literal(50),
    sourceDocuments: z.number().int().nonnegative(),
    modelName: z.string().min(1),
    crossValidation: z
      .object({
        alignment: z.enum(["supports", "mixed", "challenges"]),
        summary: z.string().min(1).max(1600),
        disagreements: z.array(z.string().min(1).max(500)).max(5),
      })
      .strict(),
    views: z.array(sellSideViewSchema).min(3).max(5),
  })
  .strict();

export const sellSidePayloadSchema = z
  .union([sellSidePayloadSchemaV2, legacySellSidePayloadSchema])
  .transform((payload) => {
    if ("logicSummary" in payload) return payload;
    return sellSidePayloadSchemaV2.parse({
      generatedAt: payload.generatedAt,
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      searchQuery: payload.searchQuery,
      maxResults: payload.maxResults,
      sourceDocuments: payload.sourceDocuments,
      modelName: payload.modelName,
      logicSummary: mergeLegacySellSideSummary(
        payload.crossValidation.summary,
        payload.crossValidation.disagreements,
      ),
      edited: false,
      updatedAt: null,
      views: payload.views,
    });
  });

export const sellSideSummaryUpdateSchema = z
  .object({
    runId: z.string().uuid(),
    logicSummary: z.string().trim().min(1).max(4000),
  })
  .strict();

export const financingModelVersionSchema = z
  .object({
    runId: z.string().uuid(),
    asOfDate: z.string().date(),
    generatedAt: z.string().min(1),
  })
  .strict();

export const financingModelReportSchema = z
  .object({
    snapshot: financingModelSnapshotSchema,
    conclusion: conclusionSchema,
    sellSide: sellSidePayloadSchema.nullable(),
    versions: z.array(financingModelVersionSchema).min(1),
  })
  .strict();

export type FinancingModelSnapshot = z.infer<
  typeof financingModelSnapshotSchema
>;
export type FinancingModelCompanyMetrics = NonNullable<
  FinancingModelSnapshot["company_metrics"]
>;
export type FinancingModelConclusion = z.infer<typeof conclusionSchema>;
export type FinancingModelConclusionUpdate = z.infer<
  typeof conclusionUpdateSchema
>;
export type TimingDecisionInput = z.infer<typeof timingDecisionInputSchema>;
export type TimingDecisionRecord = z.infer<typeof timingDecisionRecordSchema>;
export type SellSidePayload = z.infer<typeof sellSidePayloadSchema>;
export type SellSideSummaryUpdate = z.infer<
  typeof sellSideSummaryUpdateSchema
>;
export type FinancingModelVersion = z.infer<
  typeof financingModelVersionSchema
>;
export type FinancingModelReport = z.infer<typeof financingModelReportSchema>;

export function parseFinancingModelReport(value: unknown): FinancingModelReport {
  return financingModelReportSchema.parse(value);
}

export function companyBusinessNarrative(
  metrics: FinancingModelCompanyMetrics,
): string {
  const readiness = metrics.readiness_label.trim().replace(/^流动性/, "");
  const hasReadiness = readiness !== "" && readiness !== "数据不足";
  const liquidityClause = hasReadiness
    ? `流动性整体${readiness}`
    : "流动性状态暂缺";
  const spreadClause =
    metrics.ef_subject_spread_bp === null
      ? "主体利差信息暂缺"
      : metrics.ef_subject_spread_pctile === null
        ? "主体利差已有可用定价参考"
        : metrics.ef_subject_spread_pctile <= 0.33
          ? "主体利差处于相对低位"
          : metrics.ef_subject_spread_pctile >= 0.67
            ? "主体利差处于相对高位"
            : "主体利差处于常态区间";
  const demandClause =
    readiness === "偏紧" ||
    (metrics.ef_funding_gap !== null && metrics.ef_funding_gap < -100)
      ? "公司融资需求较为迫切，建议尽快完成发行"
      : readiness === "宽裕" &&
          metrics.ef_funding_gap !== null &&
          metrics.ef_funding_gap > 50
        ? "公司融资需求暂不迫切，建议等待成本较优窗口择机完成发行"
        : metrics.ef_funding_gap === null && !hasReadiness
          ? "公司融资需求尚待确认，建议补充业务指标后安排发行"
          : "公司融资需求总体适中，建议结合市场窗口择机完成发行";
  return `${liquidityClause}；${spreadClause}；${demandClause}。`;
}

export function sellSideSummaryBody(
  summary: string,
  institution: string,
): string {
  const body = summary.trim();
  const escapedInstitution = escapeRegExp(institution.trim());
  if (!escapedInstitution) return body;

  const attributionPrefix = new RegExp(
    `^${escapedInstitution}[^《]{0,40}《[^》]{1,500}》\\s*` +
      `(?:[（(]\\s*(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{4}年\\d{1,2}月\\d{1,2}日)\\s*[）)])?\\s*` +
      `(?:中\\s*)?(?:指出|认为|表示|判断|提出|称)\\s*[：:，,。；;]*\\s*`,
  );
  return body.replace(attributionPrefix, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeLegacySellSideSummary(
  summary: string,
  disagreements: string[],
): string {
  const fragments = [summary, ...disagreements]
    .map((fragment) =>
      fragment.trim().replace(/^[\s\-•]+/, "").replace(/[。；;]+$/, ""),
    )
    .filter(
      (fragment, index, values) =>
        fragment && values.indexOf(fragment) === index,
    );
  return `${fragments.join("；")}。`.slice(0, 4000);
}
