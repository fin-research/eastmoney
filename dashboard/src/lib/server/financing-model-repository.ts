import type { QueryResultRow } from "pg";

import {
  conclusionUpdateSchema,
  financingModelReportSchema,
  financingModelSnapshotSchema,
  sellSidePayloadSchema,
  sellSideSummaryUpdateSchema,
  timingDecisionHistorySchema,
  timingDecisionInputSchema,
  timingDecisionRecordSchema,
  type FinancingModelConclusion,
  type FinancingModelConclusionUpdate,
  type FinancingModelReport,
  type FinancingModelSnapshot,
  type SellSidePayload,
  type SellSideSummaryUpdate,
  type TimingDecisionInput,
  type TimingDecisionRecord,
} from "../financing-model.ts";
import type { BondDatabaseClient } from "./postgres";

export class FinancingModelDatabaseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FinancingModelDatabaseError";
    this.status = status;
  }
}

interface FinancingModelRow extends QueryResultRow {
  snapshot: unknown;
  verdict: string;
  preferred_window: string;
  narrative: string;
  conclusion_updated_at: string | null;
  sell_side_payload: unknown | null;
  versions: unknown;
}

export async function loadFinancingModelReport(
  client: BondDatabaseClient,
  runId: string | null = null,
): Promise<FinancingModelReport> {
  const result = await client.query<FinancingModelRow>(
    `SELECT
       jsonb_build_object(
         'schema_version', run.schema_version,
         'run_id', run.id,
         'model_name', run.model_name,
         'generated_at', to_char(
           run.generated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ),
         'as_of_date', to_char(run.as_of_date, 'YYYY-MM-DD'),
         'market_data_date', to_char(run.market_data_date, 'YYYY-MM-DD'),
         'online_run', CASE WHEN run.online_model_version IS NULL THEN NULL ELSE jsonb_build_object(
           'model_version', run.online_model_version,
           'feature_version', run.online_feature_version,
           'training_as_of', to_char(run.online_training_as_of, 'YYYY-MM-DD'),
           'retrain_after', to_char(run.online_retrain_after, 'YYYY-MM-DD'),
           'excluded_groups', to_jsonb(run.online_excluded_groups),
           'runtime', 'cloudflare-workflow'
         ) END,
         'issue_terms', jsonb_build_object(
           'issue_size_billion_yuan', run.issue_size_billion_yuan,
           'tenor_years', run.tenor_years,
           'rating', run.rating,
           'bond_type', run.bond_type
         ),
         'prediction', jsonb_build_object(
           'deviation_bp', run.predicted_deviation_bp,
           'peer_spread_median_bp', run.peer_spread_median_bp,
           'historical_percentile', run.historical_percentile,
           'recommendation', run.recommendation,
           'recommendation_label', run.recommendation_label,
           'window_zone', CASE run.recommendation
             WHEN 'strong_buy' THEN '较优'
             WHEN 'neutral' THEN '中枢'
             ELSE '较劣'
           END,
           'decision', run.decision
         ),
         'company_metrics', CASE
           WHEN run.company_metrics_date IS NULL THEN NULL
           ELSE jsonb_build_object(
             'date', to_char(run.company_metrics_date, 'YYYY-MM-DD'),
             'ef_lcr', run.lcr_value,
             'ef_nsfr', run.nsfr_value,
             'ef_lcr_pctile_60d', run.lcr_percentile_60d,
             'ef_nsfr_pctile_60d', run.nsfr_percentile_60d,
             'ef_funding_gap', run.funding_gap_yi_yuan,
             'ef_margin_zscore_60d', run.company_margin_zscore_60d,
             'ef_funding_pressure', run.company_funding_pressure,
             'ef_subject_spread_bp', run.subject_spread_bp,
             'ef_subject_spread_pctile', run.subject_spread_percentile,
             'ef_subject_spread_date', CASE
               WHEN run.subject_spread_date IS NULL THEN NULL
               ELSE to_char(run.subject_spread_date, 'YYYY-MM-DD')
             END,
             'composite_score', run.company_composite_score,
             'readiness_label', run.company_readiness_label,
             'interpretation', run.company_interpretation
           )
         END,
         'market_drivers', drivers.items,
         'driver_structure', driver_groups.items,
         'product_recommendation', CASE
           WHEN run.recommended_product IS NULL THEN NULL
           ELSE jsonb_build_object(
             'recommended_product', run.recommended_product,
             'recommended_tenor_years', run.recommended_tenor_years,
             'recommended_bond_type', run.recommended_bond_type,
             'scenarios', product_scenarios.items
           )
         END,
         'forecast_window', forecast.items,
         'validation', jsonb_build_object(
           'tscv', jsonb_build_object(
             'folds', run.cv_folds,
             'validation_samples', run.cv_validation_samples,
             'sample_count', run.model_sample_count,
             'sample_start_date', CASE
               WHEN run.model_sample_start_date IS NULL THEN NULL
               ELSE to_char(run.model_sample_start_date, 'YYYY-MM-DD')
             END,
             'sample_end_date', CASE
               WHEN run.model_sample_end_date IS NULL THEN NULL
               ELSE to_char(run.model_sample_end_date, 'YYYY-MM-DD')
             END,
             'rmse', run.cv_rmse,
             'mae', run.cv_mae,
             'ic', run.cv_ic,
             'best_iter_median', run.cv_best_iter_median,
             'best_iters', to_jsonb(run.cv_best_iters)
           ),
           'timing_value', jsonb_build_object(
             'n_total', run.timing_n_total,
             'n_recommended', run.timing_n_recommended,
             'recommended_share', run.timing_recommended_share,
             'cost_saving_bp', run.timing_cost_saving_bp,
             'recommended_mean_bp', run.timing_recommended_mean_bp,
             'baseline_mean_bp', run.timing_baseline_mean_bp,
             'win_rate', run.timing_win_rate,
             'ic', run.timing_ic,
             'group_means', to_jsonb(run.timing_group_means),
             'monotonic', run.timing_monotonic
           )
         ),
         'base_conclusion', jsonb_build_object(
           'verdict', run.base_conclusion_verdict,
           'preferred_window', run.base_conclusion_preferred_window,
           'narrative', run.base_conclusion_narrative,
           'preferred_dates', to_jsonb(run.base_conclusion_preferred_dates)
         ),
         'source_freshness', jsonb_build_object(
           'market_data_date', to_char(run.source_market_data_date, 'YYYY-MM-DD'),
           'company_metrics_date', CASE
             WHEN run.source_company_metrics_date IS NULL THEN NULL
             ELSE to_char(run.source_company_metrics_date, 'YYYY-MM-DD')
           END,
           'subject_spread_date', CASE
             WHEN run.source_subject_spread_date IS NULL THEN NULL
             ELSE to_char(run.source_subject_spread_date, 'YYYY-MM-DD')
           END
         )
       ) AS snapshot,
       run.conclusion_verdict AS verdict,
       run.conclusion_preferred_window AS preferred_window,
       run.conclusion_narrative AS narrative,
       CASE
         WHEN run.conclusion_updated_at IS NULL THEN NULL
         ELSE to_char(
           run.conclusion_updated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
       END AS conclusion_updated_at,
       sell_side.payload AS sell_side_payload,
       COALESCE(
         (
           SELECT jsonb_agg(
             jsonb_build_object(
               'runId', version_run.id,
               'asOfDate', to_char(version_run.as_of_date, 'YYYY-MM-DD'),
               'generatedAt', to_char(
                 version_run.generated_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
             )
             ORDER BY version_run.as_of_date DESC, version_run.generated_at DESC
           )
           FROM (
             SELECT id, as_of_date, generated_at
             FROM financing_model.model_run
             ORDER BY as_of_date DESC, generated_at DESC
             LIMIT 100
           ) AS version_run
         ),
         '[]'::jsonb
       ) AS versions
     FROM financing_model.model_run AS run
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'feature', driver.feature,
             'display_name', driver.display_name,
             'shap', driver.shap,
             'value', driver.value,
             'direction', driver.direction,
             'impact', driver.impact
           ))
           ORDER BY driver.ordinal
         ),
         '[]'::jsonb
       ) AS items
       FROM financing_model.model_run_market_driver AS driver
       WHERE driver.run_id = run.id
     ) AS drivers ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'date', to_char(forecast_row.forecast_date, 'YYYY-MM-DD'),
             'weekday', forecast_row.weekday,
             'percentile', forecast_row.percentile,
             'label', forecast_row.label,
             'pred_bp', forecast_row.predicted_deviation_bp,
             'savings_bp_vs_window_median', forecast_row.savings_bp_vs_window_median,
             'savings_万元/年', forecast_row.savings_wan_yuan_per_year
           )
           ORDER BY forecast_row.ordinal
         ),
         '[]'::jsonb
       ) AS items
       FROM financing_model.model_run_forecast_window AS forecast_row
       WHERE forecast_row.run_id = run.id
     ) AS forecast ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'category', driver_group.category,
             'display_name', driver_group.display_name,
             'support_score', driver_group.support_score,
             'support_bp', driver_group.support_bp,
             'importance_weight', driver_group.importance_weight
           )
           ORDER BY driver_group.ordinal
         ),
         '[]'::jsonb
       ) AS items
       FROM financing_model.model_run_driver_group AS driver_group
       WHERE driver_group.run_id = run.id
     ) AS driver_groups ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'display_name', scenario.display_name,
             'tenor_years', scenario.tenor_years,
             'bond_type', scenario.bond_type,
             'pred_bp', scenario.predicted_deviation_bp,
             'peer_spread_median_bp', scenario.peer_spread_median_bp,
             'historical_percentile', scenario.historical_percentile,
             'recommendation', scenario.recommendation,
             'recommendation_label', scenario.recommendation_label,
             'rank', scenario.rank,
             'cost_vs_best_bp', scenario.cost_vs_best_bp,
             'is_recommended', scenario.is_recommended
           )
           ORDER BY scenario.ordinal
         ),
         '[]'::jsonb
       ) AS items
       FROM financing_model.model_run_product_scenario AS scenario
       WHERE scenario.run_id = run.id
     ) AS product_scenarios ON true
     LEFT JOIN LATERAL (
       SELECT snapshot.payload
       FROM financing_model.sell_side_snapshot AS snapshot
       WHERE snapshot.run_id = run.id
       ORDER BY snapshot.generated_at DESC, snapshot.id DESC
       LIMIT 1
     ) AS sell_side ON true
     WHERE ($1::uuid IS NULL OR run.id = $1::uuid)
     ORDER BY run.as_of_date DESC, run.generated_at DESC
     LIMIT 1`,
    [runId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FinancingModelDatabaseError(404, "尚无融资择时模型数据");
  }

  try {
    const snapshot = financingModelSnapshotSchema.parse(row.snapshot);
    const conclusionEdited = row.conclusion_updated_at !== null;
    return financingModelReportSchema.parse({
      snapshot,
      conclusion: {
        verdict: conclusionEdited
          ? row.verdict
          : snapshot.prediction.recommendation_label,
        preferredWindow: row.preferred_window,
        narrative: row.narrative,
        edited: conclusionEdited,
        updatedAt: row.conclusion_updated_at,
      },
      sellSide:
        row.sell_side_payload === null
          ? null
          : sellSidePayloadSchema.parse(row.sell_side_payload),
      versions: row.versions,
    });
  } catch (error) {
    throw new FinancingModelDatabaseError(
      500,
      `融资择时模型数据契约无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function saveFinancingModelConclusion(
  client: BondDatabaseClient,
  input: FinancingModelConclusionUpdate,
): Promise<FinancingModelConclusion> {
  const validated = conclusionUpdateSchema.parse(input);
  const result = await client.query<{
    verdict: string;
    preferred_window: string;
    narrative: string;
    updated_at: string;
  }>(
    `UPDATE financing_model.model_run
     SET
       conclusion_verdict = $2,
       conclusion_preferred_window = $3,
       conclusion_narrative = $4,
       conclusion_updated_at = now()
     WHERE id = $1::uuid
     RETURNING
       conclusion_verdict AS verdict,
       conclusion_preferred_window AS preferred_window,
       conclusion_narrative AS narrative,
       to_char(
         conclusion_updated_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS updated_at`,
    [
      validated.runId,
      validated.verdict,
      validated.preferredWindow,
      validated.narrative,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FinancingModelDatabaseError(404, "融资择时模型运行不存在");
  }
  return {
    verdict: row.verdict,
    preferredWindow: row.preferred_window,
    narrative: row.narrative,
    edited: true,
    updatedAt: row.updated_at,
  };
}

export async function loadTimingDecisionHistory(
  client: BondDatabaseClient,
): Promise<TimingDecisionRecord[]> {
  const result = await client.query<{
    run_id: string;
    decision_date: string;
    historical_percentile: number | null;
    recommendation: "strong_buy" | "neutral" | "wait" | null;
    recommendation_label: string;
    decision_action: string;
    outcome: string;
    updated_at: string;
  }>(
    `SELECT
       decision.run_id,
       to_char(run.as_of_date, 'YYYY-MM-DD') AS decision_date,
       run.historical_percentile,
       run.recommendation,
       run.recommendation_label,
       decision.decision_action,
       decision.outcome,
       to_char(
         decision.updated_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS updated_at
     FROM financing_model.timing_decision_record AS decision
     INNER JOIN financing_model.model_run AS run ON run.id = decision.run_id
     ORDER BY run.as_of_date DESC, run.generated_at DESC
     LIMIT 100`,
  );
  return timingDecisionHistorySchema.parse(
    result.rows.map((row) => ({
      runId: row.run_id,
      decisionDate: row.decision_date,
      historicalPercentile: row.historical_percentile === null ? null : Number(row.historical_percentile),
      recommendation: row.recommendation,
      recommendationLabel: row.recommendation_label,
      decisionAction: row.decision_action,
      outcome: row.outcome,
      updatedAt: row.updated_at,
    })),
  );
}

export async function saveTimingDecisionRecord(
  client: BondDatabaseClient,
  input: TimingDecisionInput,
): Promise<TimingDecisionRecord> {
  const validated = timingDecisionInputSchema.parse(input);
  const result = await client.query<{
    run_id: string;
    decision_date: string;
    historical_percentile: number | null;
    recommendation: "strong_buy" | "neutral" | "wait" | null;
    recommendation_label: string;
    decision_action: string;
    outcome: string;
    updated_at: string;
  }>(
    `WITH saved AS (
       INSERT INTO financing_model.timing_decision_record (
         id, run_id, decision_action, outcome
       )
       SELECT $1::uuid, run.id, $3, $4
       FROM financing_model.model_run AS run
       WHERE run.id = $2::uuid
       ON CONFLICT (run_id) DO UPDATE SET
         decision_action = EXCLUDED.decision_action,
         outcome = EXCLUDED.outcome,
         updated_at = now()
       RETURNING run_id, decision_action, outcome, updated_at
     )
     SELECT
       saved.run_id,
       to_char(run.as_of_date, 'YYYY-MM-DD') AS decision_date,
       run.historical_percentile,
       run.recommendation,
       run.recommendation_label,
       saved.decision_action,
       saved.outcome,
       to_char(
         saved.updated_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS updated_at
     FROM saved
     INNER JOIN financing_model.model_run AS run ON run.id = saved.run_id`,
    [
      crypto.randomUUID(),
      validated.runId,
      validated.decisionAction,
      validated.outcome,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FinancingModelDatabaseError(404, "融资择时模型运行不存在");
  }
  return timingDecisionRecordSchema.parse({
    runId: row.run_id,
    decisionDate: row.decision_date,
    historicalPercentile: row.historical_percentile === null ? null : Number(row.historical_percentile),
    recommendation: row.recommendation,
    recommendationLabel: row.recommendation_label,
    decisionAction: row.decision_action,
    outcome: row.outcome,
    updatedAt: row.updated_at,
  });
}

export async function saveSellSideSnapshot(
  client: BondDatabaseClient,
  run: Pick<FinancingModelSnapshot, "run_id">,
  payload: SellSidePayload,
): Promise<SellSidePayload> {
  const validated = sellSidePayloadSchema.parse(payload);
  await client.query(
    `INSERT INTO financing_model.sell_side_snapshot (
       id, run_id, period_start, period_end, search_query,
       model_name, payload, generated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::date, $4::date, $5, $6, $7::jsonb,
       $8::timestamptz
     )`,
    [
      crypto.randomUUID(),
      run.run_id,
      validated.periodStart,
      validated.periodEnd,
      validated.searchQuery,
      validated.modelName,
      JSON.stringify(validated),
      validated.updatedAt ?? validated.generatedAt,
    ],
  );
  return validated;
}

export async function saveSellSideSummaryRevision(
  client: BondDatabaseClient,
  run: Pick<FinancingModelSnapshot, "run_id">,
  current: SellSidePayload,
  input: SellSideSummaryUpdate,
  updatedAt = new Date().toISOString(),
): Promise<SellSidePayload> {
  const validated = sellSideSummaryUpdateSchema.parse(input);
  if (validated.runId !== run.run_id) {
    throw new FinancingModelDatabaseError(404, "融资择时模型运行不存在");
  }
  const revised = sellSidePayloadSchema.parse({
    ...current,
    logicSummary: validated.logicSummary,
    edited: true,
    updatedAt,
  });
  return saveSellSideSnapshot(client, run, revised);
}
