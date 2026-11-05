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
export const factorGroups=['sector','cdb3','gov','aaa3','funding'] as const;
export const timingNowcastSnapshotSchema=z.object({
 schema_version:z.literal('timing-advice-v2'),run_id:z.string().uuid(),generated_at:z.string(),as_of_date:z.string().date(),market_source_date:z.string().date(),
 model_version:z.string().regex(/^[a-f0-9]{20}$/),training_label_cutoff:z.string().date(),scope:z.literal('AAA证券公司债3Y'),
 forecast:z.object({catch_up_bp:finite,wait_bp:finite,wait_quotes:z.literal(3),threshold_bp:finite.positive(),
  source_yield_pct:finite.positive().optional(),decision_quote_date:z.string().date().optional(),wait_quote_date:z.string().date().nullable().optional(),catch_up_base_bp:finite.optional(),wait_base_bp:finite.optional()}),
 history:z.array(z.object({date:z.string().date(),yield_pct:finite.positive()})).min(1).max(30).optional(),
 attribution:z.array(z.object({group:z.enum(factorGroups),catch_up_bp:finite,wait_bp:finite})).length(5).optional(),
 probabilities:z.object({defer:finite.min(0).max(1),wait:finite.min(0).max(1),issue:finite.min(0).max(1)}),
 decision:z.object({action:z.enum(['尽快','等待','暂缓'])}),
 validation:z.object({validation_scope:z.literal('walk_forward'),status:z.literal('post_hoc_selected'),sample_count:z.number().int().positive(),prediction_start:z.string().date(),prediction_end:z.string().date(),catch_up_corr:finite.min(-1).max(1),catch_up_r2:finite.max(1),wait_corr:finite.min(-1).max(1),spread_bp:finite,spread_ci_low_bp:finite,spread_ci_high_bp:finite}),
 base_conclusion:z.object({verdict:z.string(),preferred_window:z.string(),narrative:z.string()}),
}).superRefine((s,ctx)=>{
 const p=s.probabilities,f=s.forecast;
 if(Math.abs(p.defer+p.wait+p.issue-1)>1e-8)ctx.addIssue({code:'custom',message:'概率之和必须为1'});
 if(s.decision.action!==(f.wait_bp>f.threshold_bp?'尽快':f.wait_bp<-f.threshold_bp?'暂缓':'等待'))ctx.addIssue({code:'custom',message:'建议必须来自预测值与阈值'});
 if(s.market_source_date>=s.as_of_date)ctx.addIssue({code:'custom',message:'行情日期必须早于模型日期'});
 const detail=[f.source_yield_pct,f.decision_quote_date,f.catch_up_base_bp,f.wait_base_bp,s.history,s.attribution];
 if(detail.some(x=>x!==undefined)){
  if(detail.some(x=>x===undefined)||f.wait_quote_date===undefined){ctx.addIssue({code:'custom',message:'预测水平、近期报价和因子贡献必须同时提供'});return;}
  const sum=(key:'catch_up_bp'|'wait_bp')=>s.attribution!.reduce((total,row)=>total+row[key],0);
  if(new Set(s.attribution!.map(row=>row.group)).size!==5)ctx.addIssue({code:'custom',message:'因子组不能重复'});
  if(Math.abs(f.wait_base_bp!+sum('wait_bp')-f.wait_bp)>=1e-6||Math.abs(f.catch_up_base_bp!+sum('catch_up_bp')-f.catch_up_bp)>=1e-6)ctx.addIssue({code:'custom',message:'基值加全部贡献必须还原预测值'});
  if(f.decision_quote_date!<=s.market_source_date||(f.wait_quote_date!==null&&f.wait_quote_date<=f.decision_quote_date!))ctx.addIssue({code:'custom',message:'报价日顺序必须为行情日、决策日、此后第3个报价日'});
  if(s.history!.at(-1)!.date!==s.market_source_date||s.history!.at(-1)!.yield_pct!==f.source_yield_pct)ctx.addIssue({code:'custom',message:'近期报价必须以行情日报价结束'});
 }
});
export const timingAdviceReportSchema=z.object({model_status:modelStatusSchema,snapshot:z.union([timingAdviceSnapshotSchema,timingNowcastSnapshotSchema]),conclusion:conclusionSchema,sellSide:sellSidePayloadSchema.nullable(),versions:z.array(financingModelVersionSchema),business_metrics:issuanceBusinessMetricsSchema.nullable().optional()});
export type TimingAdviceSnapshot=z.infer<typeof timingAdviceSnapshotSchema>;
export type TimingNowcastSnapshot=z.infer<typeof timingNowcastSnapshotSchema>;
export type TimingAdviceReport=z.infer<typeof timingAdviceReportSchema>;
export const currentFinancingReportSchema=z.union([timingAdviceReportSchema,issuanceReportSchema]);
export type CurrentFinancingReport=z.infer<typeof currentFinancingReportSchema>;
export const parseCurrentFinancingReport=(value:unknown):CurrentFinancingReport=>currentFinancingReportSchema.parse(value);
