import { z } from 'zod';
import { conclusionSchema, financingModelVersionSchema, sellSidePayloadSchema } from './financing-model.ts';
const number = z.number().finite();
const nullable = number.nullable();
export const issuanceForecastSchema = z.object({
  forecast_origin:z.string().date(), effective_horizon:z.number().int().nonnegative(),
  market_change_bp:number, market_volatility_bp:nullable, market_source_date:z.string().date(),
  market_train_label_end:z.string().date(), market_training_samples:z.number().int().nonnegative(),
  primary_history_latest_date:z.string().date().nullable(), calibration_latest_label:z.string().date().nullable(), status:z.string(),
  date:z.string().date(), lead_days:z.number().int().min(0).max(90), coupon_percent:nullable,
  coupon_low_percent:nullable, coupon_high_percent:nullable, market_level_percent:number,
  net_saving_bp:nullable, expected_saving_bp:nullable, waiting_cost_bp:nullable, annual_saving_wan:nullable,
  saving_probability:number.min(0).max(1).nullable(), saving_p10_bp:nullable, pair_samples:z.number().int().nullable(), interval_samples:z.number().int(),
  own_observations:z.number().int(), peer_observations:z.number().int(), issuer_premium_bp:nullable,
});
const productScenarioSchema=z.object({tenor:number.positive(),bond_type:z.enum(['证券公司债','证券公司次级债']),coupon_percent:nullable,own_observations:z.number().int().nonnegative(),peer_observations:z.number().int().nonnegative()});
const productScenariosSchema=z.array(productScenarioSchema).refine(rows=>rows.length===0||(
  rows.length===4&&rows.every((row,index)=>row.tenor===(index%2===0?3:5)&&row.bond_type===(index<2?'证券公司债':'证券公司次级债'))
),{message:'四品种情景必须按3年/5年公募债、次级债顺序'});
export const issuanceSnapshotSchema = z.object({
  schema_version:z.literal('issuance-forecast-v1'),run_id:z.string().uuid(),generated_at:z.string(),as_of_date:z.string().date(),
  market_source_date:z.string().date(),deadline:z.string().date(),window_days:z.number().int().min(1).max(90),market_model:z.literal('unified_coupon'),
  terms:z.object({issuer:z.string(),rating:z.string(),tenor:number.positive(),bond_type:z.string(),placement_type:z.string()}),issue_size_yi:number.positive(),waiting_cost_bp_day:number.nonnegative(),
  decision:z.object({action:z.string(),reason:z.string(),scope:z.string(),validation_status:z.string(),first_issuance_date:z.string().date().nullable(),lowest_expected_cost_date:z.string().date().nullable(),
    low_rate_dates:z.array(z.string().date()),low_rate_windows:z.array(z.object({start:z.string().date(),end:z.string().date()})),
    expected_net_saving_bp:nullable,annual_saving_wan:nullable,saving_probability:number.min(0).max(1).nullable(),saving_p10_bp:nullable,joint_error_pairs:z.number().int().nullable()}),
  forecast:z.array(issuanceForecastSchema),market_forecast:z.array(z.object({date:z.string().date(),market_level_percent:number,quote_day:z.boolean(),issuance_day:z.boolean(),value_date:z.string().date(),status:z.string()})),
  product_scenarios:productScenariosSchema.default([]),
  explanation:z.object({method:z.enum(['tree_path_dependent','linear','additive_market_coupon','relu_path_integrated_gradients']),unit:z.literal('bp'),base_coupon_bp:number,prediction_coupon_bp:number,market_anchor_bp:number,issuer_premium_bp:number,horizon_drift_bp:number,tree_expected_change_bp:number,
    features:z.array(z.object({feature:z.string(),value:nullable,shap_bp:number}))}).nullable(),
  validation:z.object({sample_count:z.number().int(),prediction_start:z.string().date(),prediction_end:z.string().date(),
    metrics:z.array(z.object({lead_days:z.number().int(),year:z.number().int(),samples:z.number().int(),mae_bp:number,rmse_bp:number,flat_market_mae_bp:nullable,mae_skill_vs_flat_market:nullable,win_rate:number.min(0).max(1).nullable(),hit_rate_5bp:number.min(0).max(1).nullable().default(null),error_std_bp:nullable,bias_bp:number}))}),
  base_conclusion:z.object({verdict:z.string(),preferred_window:z.string(),narrative:z.string()}),
});
const liquidityMetricSchema=z.object({date:z.string().date(),value_ratio:number,historical_percentile:number.min(0).max(100).nullable(),sample_count:z.number().int().nonnegative()});
export const issuanceBusinessMetricsSchema=z.object({
  lcr:liquidityMetricSchema.nullable(),nsfr:liquidityMetricSchema.nullable(),
  funding_gap:z.object({date:z.string().date(),value_yi:number,historical_percentile:number.min(0).max(100).nullable(),sample_count:z.number().int().nonnegative()}).nullable().optional(),
  issuer_spread:z.object({date:z.string().date(),spread_bp:nullable,outstanding_bonds:z.number().int().nonnegative(),balance_cny:number.nonnegative(),historical_percentile:number.min(0).max(100).nullable().optional(),sample_count:z.number().int().nonnegative().optional()}).nullable(),
});
export const modelStatusSchema=z.object({model_version:z.string().nullable(),status:z.enum(['active','suspended']),reason:z.string()});
export const issuanceReportSchema=z.object({model_status:modelStatusSchema.default({model_version:null,status:'suspended',reason:'quality_review_required'}),snapshot:issuanceSnapshotSchema,conclusion:conclusionSchema,sellSide:sellSidePayloadSchema.nullable(),versions:z.array(financingModelVersionSchema),business_metrics:issuanceBusinessMetricsSchema.nullable().optional()});
export type IssuanceSnapshot=z.infer<typeof issuanceSnapshotSchema>;
export type IssuanceReport=z.infer<typeof issuanceReportSchema>;
export const parseIssuanceReport=(value:unknown):IssuanceReport=>issuanceReportSchema.parse(value);
