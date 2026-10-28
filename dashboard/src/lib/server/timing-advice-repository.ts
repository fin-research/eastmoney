import { timingAdviceReportSchema, type CurrentFinancingReport } from '../timing-advice.ts';
import type { BondDatabaseClient } from './postgres';
import { FinancingModelDatabaseError } from './financing-model-repository.ts';
import { loadIssuanceModelReport, applyIssuanceModelStatus } from './issuance-model-repository.ts';
export async function loadCurrentFinancingReport(client:BondDatabaseClient,runId:string|null=null):Promise<CurrentFinancingReport>{
 const selected=await client.query<{id:string;schema_version:number}>(`SELECT id,schema_version FROM financing_model.model_run WHERE schema_version IN (4,5) AND online_feature_version IN ('issuance-coupon','timing-advice-v1') AND ($1::uuid IS NULL OR id=$1::uuid) ORDER BY as_of_date DESC LIMIT 1`,[runId]);
 if(!selected.rows[0])throw new FinancingModelDatabaseError(404,'尚无融资择时模型数据');
 const selectedId=selected.rows[0].id;
 if(selected.rows[0].schema_version===4){const report=await loadIssuanceModelReport(client,selectedId);return runId===null ? applyIssuanceModelStatus(report) : report;}
 const result=await client.query<{report:unknown}>(`SELECT jsonb_build_object(
 'model_status',jsonb_build_object('model_version',r.online_model_version,'status',COALESCE(q.status,'suspended'),'reason',COALESCE(q.reason,'quality_review_required')),
 'snapshot',jsonb_build_object('schema_version','timing-advice-v1','run_id',r.id,'generated_at',r.generated_at,'as_of_date',r.as_of_date,'market_source_date',r.market_data_date,'model_version',r.online_model_version,'training_label_cutoff',t.training_label_cutoff,'scope',t.scope,'window_days',t.window_days,
 'probabilities',jsonb_build_object('defer',t.probability_defer,'wait',t.probability_wait,'issue',t.probability_issue),'decision',jsonb_build_object('action',t.action),
 'validation',jsonb_build_object('validation_scope',t.validation_scope,'status',t.validation_status,'sample_count',t.sample_count,'prediction_start',t.prediction_start,'prediction_end',t.prediction_end,'logloss',t.logloss,'brier',t.brier,'immediate_tp',t.immediate_tp,'immediate_fp',t.immediate_fp,'immediate_target',t.immediate_target,'immediate_precision',t.immediate_precision,'immediate_recall',t.immediate_recall,'selected_a_mean_bp',t.selected_a_mean_bp),
 'base_conclusion',jsonb_build_object('verdict',r.base_conclusion_verdict,'preferred_window',r.base_conclusion_preferred_window,'narrative',r.base_conclusion_narrative)),
 'conclusion',jsonb_build_object('verdict',r.conclusion_verdict,'preferredWindow',r.conclusion_preferred_window,'narrative',r.conclusion_narrative,'edited',r.conclusion_updated_at IS NOT NULL,'updatedAt',r.conclusion_updated_at),
 'sellSide',(SELECT payload FROM financing_model.sell_side_snapshot WHERE run_id=r.id ORDER BY generated_at DESC,id DESC LIMIT 1),
 'versions',(SELECT jsonb_agg(jsonb_build_object('runId',v.id,'asOfDate',v.as_of_date,'generatedAt',v.generated_at) ORDER BY v.as_of_date DESC) FROM (SELECT id,as_of_date,generated_at FROM financing_model.model_run WHERE schema_version IN (4,5) AND online_feature_version IN ('issuance-coupon','timing-advice-v1') ORDER BY as_of_date DESC LIMIT 100)v)) AS report
 FROM financing_model.model_run r JOIN financing_model.timing_run t ON t.run_id=r.id LEFT JOIN financing_model.model_eligibility q ON q.model_version=r.online_model_version WHERE r.schema_version=5 AND r.id=$1::uuid`,[selectedId]);
 if(!result.rows[0])throw new FinancingModelDatabaseError(404,'尚无融资择时模型数据');
 const report=timingAdviceReportSchema.parse(result.rows[0].report);
 if(runId===null && report.model_status.status!=='active')throw new FinancingModelDatabaseError(409,'数据不满足要求，暂停预测');
 return report;
}
