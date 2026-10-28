import type { CurrentFinancingReport } from '../timing-advice';
import { issuanceReportSchema, type IssuanceReport } from '../issuance-model.ts';
import type { BondDatabaseClient } from './postgres';
import type { SellSidePayload } from '../financing-model.ts';
import { FinancingModelDatabaseError, saveSellSideSnapshot } from './financing-model-repository.ts';

export async function loadIssuanceModelReport(client:BondDatabaseClient,runId:string|null=null):Promise<IssuanceReport> {
  const result=await client.query<{report:unknown}>(`SELECT jsonb_build_object(
    'model_status',jsonb_build_object('model_version',r.online_model_version,'status',COALESCE(q.status,'suspended'),'reason',COALESCE(q.reason,'quality_review_required')),
    'snapshot',jsonb_build_object(
      'schema_version','issuance-forecast-v1','run_id',r.id,'generated_at',r.generated_at,'as_of_date',r.as_of_date,
      'market_source_date',r.market_data_date,'deadline',i.deadline,'window_days',i.window_days,'market_model',i.market_model,
      'terms',jsonb_build_object('issuer',i.issuer,'rating',r.rating,'tenor',r.tenor_years,'bond_type',r.bond_type,'placement_type',i.placement_type),
      'issue_size_yi',r.issue_size_billion_yuan,'waiting_cost_bp_day',i.waiting_cost_bp_day,
      'decision',jsonb_build_object('action',i.action,'reason',i.reason,'scope',i.decision_scope,'validation_status',i.validation_status,'first_issuance_date',i.first_issuance_date,'lowest_expected_cost_date',i.lowest_expected_cost_date,
        'low_rate_dates',i.low_rate_dates,'low_rate_windows',i.low_rate_windows,'expected_net_saving_bp',i.expected_net_saving_bp,'annual_saving_wan',i.annual_saving_wan,'saving_probability',i.saving_probability,'saving_p10_bp',i.saving_p10_bp,'joint_error_pairs',i.joint_error_pairs),
      'forecast',COALESCE((SELECT jsonb_agg(to_jsonb(f)-'run_id'-'ordinal' ORDER BY ordinal) FROM financing_model.issuance_forecast f WHERE f.run_id=r.id),'[]'::jsonb),
      'product_scenarios',i.product_scenarios,
      'market_forecast',COALESCE((SELECT jsonb_agg(to_jsonb(f)-'run_id'-'ordinal' ORDER BY ordinal) FROM financing_model.issuance_market_path f WHERE f.run_id=r.id),'[]'::jsonb),
      'explanation',CASE WHEN i.base_coupon_bp IS NULL THEN NULL ELSE jsonb_build_object('method',i.explanation_method,'unit','bp','base_coupon_bp',i.base_coupon_bp,'prediction_coupon_bp',i.prediction_coupon_bp,
        'market_anchor_bp',i.market_anchor_bp,'issuer_premium_bp',i.issuer_premium_bp,'horizon_drift_bp',i.horizon_drift_bp,'tree_expected_change_bp',i.tree_expected_change_bp,
        'features',COALESCE((SELECT jsonb_agg(to_jsonb(s)-'run_id'-'ordinal' ORDER BY ordinal) FROM financing_model.issuance_shap s WHERE s.run_id=r.id),'[]'::jsonb)) END,
      'validation',jsonb_build_object('sample_count',i.sample_count,'prediction_start',i.prediction_start,'prediction_end',i.prediction_end,
        'metrics',COALESCE((SELECT jsonb_agg(to_jsonb(v)-'run_id' ORDER BY lead_days,year) FROM financing_model.issuance_validation v WHERE v.run_id=r.id),'[]'::jsonb)),
      'base_conclusion',jsonb_build_object('verdict',r.base_conclusion_verdict,'preferred_window',r.base_conclusion_preferred_window,'narrative',r.base_conclusion_narrative)),
    'conclusion',jsonb_build_object('verdict',r.conclusion_verdict,'preferredWindow',r.conclusion_preferred_window,'narrative',r.conclusion_narrative,'edited',r.conclusion_updated_at IS NOT NULL,'updatedAt',r.conclusion_updated_at),
    'sellSide',(SELECT payload FROM financing_model.sell_side_snapshot s WHERE s.run_id=r.id ORDER BY generated_at DESC,id DESC LIMIT 1),
    'versions',(SELECT jsonb_agg(jsonb_build_object('runId',v.id,'asOfDate',v.as_of_date,'generatedAt',v.generated_at) ORDER BY v.as_of_date DESC) FROM
      (SELECT id,as_of_date,generated_at FROM financing_model.model_run WHERE ((schema_version=4 AND online_feature_version='issuance-coupon') OR (schema_version=5 AND online_feature_version='timing-advice-v1')) ORDER BY as_of_date DESC LIMIT 100) v)
    ) AS report FROM financing_model.model_run r JOIN financing_model.issuance_run i ON i.run_id=r.id
    LEFT JOIN financing_model.model_eligibility q ON q.model_version=r.online_model_version
    WHERE r.schema_version=4 AND r.online_feature_version='issuance-coupon' AND ($1::uuid IS NULL OR r.id=$1::uuid) ORDER BY r.as_of_date DESC LIMIT 1`,[runId]);
  if(!result.rows[0]) throw new FinancingModelDatabaseError(404,'尚无新版融资择时模型数据');
  return applyIssuanceModelStatus(issuanceReportSchema.parse(result.rows[0].report), runId !== null);
}

export async function loadIssuanceModelMetricSource(
  client: BondDatabaseClient,
  runId: string,
): Promise<{ issuer: string; marketDate: string }> {
  const result = await client.query<{ issuer: string; market_date: string }>(
    `SELECT CASE WHEN r.schema_version=5 THEN '东方财富证券股份有限公司' ELSE i.issuer END AS issuer, r.market_data_date::text AS market_date
     FROM financing_model.model_run r
     LEFT JOIN financing_model.issuance_run i ON i.run_id = r.id
     WHERE r.schema_version IN (4,5) AND r.id = $1::uuid`,
    [runId],
  );
  if (!result.rows[0]) throw new FinancingModelDatabaseError(404, '尚无新版融资择时模型数据');
  return { issuer: result.rows[0].issuer, marketDate: result.rows[0].market_date };
}


/** Preserve stored history while withholding suspended values from the default live report. */
export function applyIssuanceModelStatus(report: IssuanceReport, audit = false): IssuanceReport {
  if (report.model_status.status === 'active' || audit) return report;
  const paused = '数据不满足要求，暂停预测';
  return {...report,
    conclusion: report.conclusion.edited ? report.conclusion : {...report.conclusion,verdict:'暂停预测',preferredWindow:'',narrative:paused},
    snapshot: {...report.snapshot,forecast:[],product_scenarios:[],market_forecast:[],explanation:null,
      validation:{...report.snapshot.validation,metrics:[]},
      decision:{...report.snapshot.decision,action:'暂停预测',reason:paused,scope:'data_quality',validation_status:'suspended',
        first_issuance_date:null,lowest_expected_cost_date:null,low_rate_dates:[],low_rate_windows:[],
        expected_net_saving_bp:null,annual_saving_wan:null,saving_probability:null,saving_p10_bp:null,joint_error_pairs:null},
      base_conclusion:{verdict:'暂停预测',preferred_window:'',narrative:paused}}};
}


/** AI completion cannot publish against a model suspended or replaced during generation. */
export async function saveActiveIssuanceSellSide(client: BondDatabaseClient, report: CurrentFinancingReport, payload: SellSidePayload): Promise<SellSidePayload> {
  await client.query('BEGIN');
  try {
    const eligible=await client.query(`SELECT 1 FROM financing_model.model_run r
      JOIN financing_model.model_eligibility q ON q.model_version=r.online_model_version
      WHERE r.id=$1::uuid AND r.online_model_version=$2 AND q.status='active' FOR SHARE OF r,q`,
      [report.snapshot.run_id,report.model_status.model_version]);
    if (!eligible.rows.length) throw new FinancingModelDatabaseError(409,'数据不满足要求，暂停预测');
    const saved=await saveSellSideSnapshot(client,report.snapshot,payload);
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
