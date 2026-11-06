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
export const timingNowcastSnapshotSchema=z.object({
 schema_version:z.literal('timing-advice-v2'),run_id:z.string().uuid(),generated_at:z.string(),as_of_date:z.string().date(),market_source_date:z.string().date(),
 model_version:z.string().regex(/^[a-f0-9]{20}$/),training_label_cutoff:z.string().date(),scope:z.literal('AAA证券公司债3Y'),
 forecast:z.object({catch_up_bp:finite,wait_bp:finite,wait_quotes:z.literal(3),threshold_bp:finite.positive()}),
 probabilities:z.object({defer:finite.min(0).max(1),wait:finite.min(0).max(1),issue:finite.min(0).max(1)}),
 decision:z.object({action:z.enum(['尽快','等待','暂缓'])}),
 validation:z.object({validation_scope:z.literal('walk_forward'),status:z.literal('post_hoc_selected'),sample_count:z.number().int().positive(),prediction_start:z.string().date(),prediction_end:z.string().date(),catch_up_corr:finite.min(-1).max(1),catch_up_r2:finite.max(1),wait_corr:finite.min(-1).max(1),spread_bp:finite,spread_ci_low_bp:finite,spread_ci_high_bp:finite}),
 base_conclusion:z.object({verdict:z.string(),preferred_window:z.string(),narrative:z.string()}),
}).superRefine((s,ctx)=>{
 const p=s.probabilities,f=s.forecast;
 if(Math.abs(p.defer+p.wait+p.issue-1)>1e-8)ctx.addIssue({code:'custom',message:'概率之和必须为1'});
 if(s.decision.action!==(f.wait_bp>f.threshold_bp?'尽快':f.wait_bp<-f.threshold_bp?'暂缓':'等待'))ctx.addIssue({code:'custom',message:'建议必须来自预测值与阈值'});
 if(s.market_source_date>=s.as_of_date)ctx.addIssue({code:'custom',message:'行情日期必须早于模型日期'});
});
const couponGroups=['利率','信用','资金面','基本面','一级发行','二级行情','发行条款'] as const;
const couponKeys=['3y-public','3y-sub','5y-public','5y-sub'] as const;
const couponWindow=z.object({start:z.string().date(),end:z.string().date(),sample_count:z.number().int().positive(),mae_bp:finite.nonnegative(),hit_rate_5bp:finite.min(0).max(1),win_rate_vs_issuer_median:finite.min(0).max(1)});
export const couponForecastSchema=z.object({
 run_id:z.string().uuid(),as_of_date:z.string().date(),market_source_date:z.string().date(),model_version:z.string().regex(/^[a-f0-9]{20}$/),issuer:z.string().min(1),training_label_cutoff:z.string().date(),
 timing:z.object({action:z.enum(['尽快','等待','暂缓']),catch_up_bp:finite,wait_bp:finite}),
 products:z.array(z.object({
  key:z.enum(couponKeys),label:z.string().min(1),tenor:z.union([z.literal(3),z.literal(5)]),bond_type:z.enum(['证券公司债','证券公司次级债']),
  anchor_pct:finite.positive(),issuer_median_bp:finite,intercept_bp:finite,base_coupon_bp:finite,deviation_bp:finite,coupon_pct:finite.positive(),n_prior:z.number().int().min(2),planned_amount_yi:finite.positive(),
  groups:z.array(z.object({group:z.enum(couponGroups),net_bp:finite})).length(7),
  contributions:z.array(z.object({feature:z.string().min(1),label:z.string().min(1),group:z.enum(couponGroups),value:finite,contribution_bp:finite})).min(1),
  path:z.array(z.object({date:z.string().date(),coupon_percent:finite.positive()})).min(1).max(10),
 })).length(4),
 validation:z.object({training_events:z.number().int().positive(),first_training_event:z.string().date(),development:couponWindow,holdout:couponWindow}),
}).superRefine((c,ctx)=>{
 if(new Set(c.products.map(p=>p.key)).size!==4)ctx.addIssue({code:'custom',message:'四个品种不能重复'});
 for(const p of c.products){
  const total=p.groups.reduce((a,g)=>a+g.net_bp,0);
  if(new Set(p.groups.map(g=>g.group)).size!==7)ctx.addIssue({code:'custom',message:'因子大类不能重复'});
  if(Math.abs(p.base_coupon_bp+total-p.coupon_pct*100)>=1e-6)ctx.addIssue({code:'custom',message:'基值加全部贡献必须还原预测发行利率'});
 }
});
export type CouponForecast=z.infer<typeof couponForecastSchema>;
export const timingAdviceReportSchema=z.object({coupon:couponForecastSchema.nullable().optional(),model_status:modelStatusSchema,snapshot:z.union([timingAdviceSnapshotSchema,timingNowcastSnapshotSchema]),conclusion:conclusionSchema,sellSide:sellSidePayloadSchema.nullable(),versions:z.array(financingModelVersionSchema),business_metrics:issuanceBusinessMetricsSchema.nullable().optional()});
export type TimingAdviceSnapshot=z.infer<typeof timingAdviceSnapshotSchema>;
export type TimingNowcastSnapshot=z.infer<typeof timingNowcastSnapshotSchema>;
export type TimingAdviceReport=z.infer<typeof timingAdviceReportSchema>;
export const currentFinancingReportSchema=z.union([timingAdviceReportSchema,issuanceReportSchema]);
export type CurrentFinancingReport=z.infer<typeof currentFinancingReportSchema>;
export const parseCurrentFinancingReport=(value:unknown):CurrentFinancingReport=>currentFinancingReportSchema.parse(value);
