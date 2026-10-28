export function issuanceSnapshot() {
  const asOf='2026-08-24', add=d=>new Date(Date.parse(asOf)+d*86400000).toISOString().slice(0,10);
  const terms={issuer:'测试证券股份有限公司',rating:'AAA',tenor:3,bond_type:'证券公司债',placement_type:'公募'};
  const forecast=[0,1,2,3,4,7,8,9,10].map(h=>({date:add(h),as_of:asOf,...terms,lead_days:h,forecast_origin:asOf,effective_horizon:h,
    market_change_bp:-h*.3,market_level_percent:1.75-h*.003,market_volatility_bp:1.2,market_source_date:'2026-08-21',market_train_label_end:'2026-08-20',market_training_samples:1000,
    issuer_premium_bp:10,coupon_percent:1.85-h*.003,own_observations:9,peer_observations:80,primary_history_latest_date:'2026-08-20',status:'estimated',
    coupon_low_percent:1.7-h*.004,coupon_high_percent:2-h*.002,interval_samples:80,calibration_latest_label:'2026-08-20',
    expected_saving_bp:h*.3,waiting_cost_bp:h*.2,net_saving_bp:h*.1,annual_saving_wan:h*3,saving_probability:h?.7:null,saving_p10_bp:h?-8:null,pair_samples:h?23:0}));
  const features=[
    {feature:'rate_gov_1y_change_1',value:.3,shap_bp:.1318},
    {feature:'rate_gov_10y_change_5',value:-.55,shap_bp:-.1027},
    {feature:'credit_spread_pctile_60d',value:.0167,shap_bp:.0792},
    {feature:'rate_gov_3y_change_1',value:.05,shap_bp:.064},
    {feature:'net_financing_zscore',value:1.2374,shap_bp:.0297},
    {feature:'issue_count_20d',value:1871,shap_bp:.0259},
    {feature:'credit_bond_volume_ratio',value:null,shap_bp:.0211},
    {feature:'weighted_cost_chg_20d',value:-.1658,shap_bp:-.0195},
    {feature:'macro_PMI_change_1m',value:.6,shap_bp:-.006},
    {feature:'macro_PMI_level',value:49.8,shap_bp:-.0054},
    {feature:'dr007',value:1.7,shap_bp:-.03},
    {feature:'days_to_quarter_end',value:37,shap_bp:.001},
    {feature:'issuer',value:1,shap_bp:3.849},
    {feature:'issuer_secondary_spread_bp',value:10,shap_bp:-1.624},
    {feature:'lead_days',value:0,shap_bp:1.61},
    {feature:'peer_premium_mean_bp',value:12,shap_bp:-2.754},
    {feature:'unknown_market_value',value:1,shap_bp:2},
  ];
  const sum=features.reduce((total,row)=>total+row.shap_bp,0);
  return {schema_version:'issuance-forecast-v1',run_id:'78c6fba5-e7b0-4d0f-bc18-2c8968b8e447',generated_at:'2026-08-24T02:00:00Z',as_of_date:asOf,market_source_date:'2026-08-21',deadline:add(10),window_days:10,market_model:'unified_coupon',terms,issue_size_yi:30,waiting_cost_bp_day:.2,
    decision:{action:'等待',reason:'lowest_quartile',low_rate_dates:[add(8),add(9),add(10)],low_rate_windows:[{start:add(8),end:add(10)}],first_issuance_date:asOf,lowest_expected_cost_date:add(10),expected_net_saving_bp:1,annual_saving_wan:30,saving_probability:.7,saving_p10_bp:-8,joint_error_pairs:23,scope:'funding-cost comparison',validation_status:'2026 previously observed research reference'},
    forecast,product_scenarios:[
      {tenor:3,bond_type:'证券公司债',coupon_percent:1.85,own_observations:9,peer_observations:80},
      {tenor:5,bond_type:'证券公司债',coupon_percent:1.98,own_observations:4,peer_observations:35},
      {tenor:3,bond_type:'证券公司次级债',coupon_percent:2.12,own_observations:2,peer_observations:9},
      {tenor:5,bond_type:'证券公司次级债',coupon_percent:2.24,own_observations:1,peer_observations:6},
    ],market_forecast:Array.from({length:11},(_,h)=>({date:add(h),market_level_percent:1.75-h*.003,quote_day:![5,6].includes(h),issuance_day:![5,6].includes(h),value_date:add(h),status:'forecast'})),
    explanation:{method:'tree_path_dependent',unit:'bp',base_coupon_bp:185-sum,prediction_coupon_bp:185,market_anchor_bp:175,issuer_premium_bp:10,horizon_drift_bp:0,tree_expected_change_bp:-sum,
      features},
    validation:{sample_count:1000,prediction_start:'2022-01-04',prediction_end:'2026-08-20',metrics:[0,30].map(h=>({lead_days:h,year:2026,samples:80,mae_bp:h?7:5.6,rmse_bp:8,flat_market_mae_bp:8.2,mae_skill_vs_flat_market:.1,win_rate:h?.52:.68,hit_rate_5bp:h?.575:.625,error_std_bp:5,bias_bp:.3}))},
    calendar_audit:{calendar:{year:2026,issuance_source:'https://www.sse.com.cn/'}},
    base_conclusion:{verdict:'可按资金计划发行',preferred_window:add(10),narrative:'预期节约有限，按资金计划发行。'}};
}
