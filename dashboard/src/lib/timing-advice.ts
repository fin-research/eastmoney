import { z } from 'zod';
import { conclusionSchema, financingModelVersionSchema, sellSidePayloadSchema } from './financing-model.ts';
import { issuanceReportSchema, issuanceBusinessMetricsSchema, modelStatusSchema } from './issuance-model.ts';
const finite=z.number().finite();
export const timingAdviceSnapshotSchema=z.object({
 schema_version:z.literal('timing-advice-v1'),run_id:z.string().uuid(),generated_at:z.string(),as_of_date:z.string().date(),market_source_date:z.string().date(),
 model_version:z.string().regex(/^[a-f0-9]{20}$/),training_label_cutoff:z.string().date(),scope:z.literal('AAA证券公司债3Y'),window_days:z.literal(30),
 probabilities:z.object({defer:finite.min(0).max(1),wait:finite.min(0).max(1),issue:finite.min(0).max(1)}),
 decision:z.object({action:z.enum(['尽快','等待','暂缓'])}),
 validation:z.object({validation_scope:z.literal('inner_development'),status:z.literal('user_selected_exploratory'),sample_count:z.number().int().positive(),prediction_start:z.string().date(),prediction_end:z.string().date(),logloss:finite.nonnegative(),brier:finite.nonnegative(),immediate_tp:z.number().int().nonnegative(),immediate_fp:z.number().int().nonnegative(),immediate_target:z.number().int().positive(),immediate_precision:finite.min(0).max(1),immediate_recall:finite.min(0).max(1),selected_a_mean_bp:finite}),
 base_conclusion:z.object({verdict:z.string(),preferred_window:z.string(),narrative:z.string()}),
}).superRefine((s,ctx)=>{
 const p=s.probabilities;
 if(Math.abs(p.defer+p.wait+p.issue-1)>1e-8)ctx.addIssue({code:'custom',message:'概率之和必须为1'});
 const actions=['暂缓','等待','尽快'] as const, values=[p.defer,p.wait,p.issue];
 if(s.decision.action!==actions[values.indexOf(Math.max(...values))])ctx.addIssue({code:'custom',message:'建议必须来自模型概率最大项'});
 if(s.market_source_date>=s.as_of_date)ctx.addIssue({code:'custom',message:'行情日期必须早于模型日期'});
});
export const timingAdviceReportSchema=z.object({model_status:modelStatusSchema,snapshot:timingAdviceSnapshotSchema,conclusion:conclusionSchema,sellSide:sellSidePayloadSchema.nullable(),versions:z.array(financingModelVersionSchema),business_metrics:issuanceBusinessMetricsSchema.nullable().optional()});
export type TimingAdviceSnapshot=z.infer<typeof timingAdviceSnapshotSchema>;
export type TimingAdviceReport=z.infer<typeof timingAdviceReportSchema>;
export const currentFinancingReportSchema=z.union([timingAdviceReportSchema,issuanceReportSchema]);
export type CurrentFinancingReport=z.infer<typeof currentFinancingReportSchema>;
export const parseCurrentFinancingReport=(value:unknown):CurrentFinancingReport=>currentFinancingReportSchema.parse(value);
