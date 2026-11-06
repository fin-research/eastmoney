export function timingAdviceSnapshot(){return {
 schema_version:'timing-advice-v1',run_id:'00000000-0000-4000-8000-000000000028',generated_at:'2026-10-28T01:00:00Z',as_of_date:'2026-10-28',market_source_date:'2026-10-27',training_label_cutoff:'2025-12-31',model_version:'abcdef0123456789abcd',scope:'AAA证券公司债3Y',window_days:30,
 probabilities:{defer:.15,wait:.3,issue:.55},decision:{action:'尽快'},validation:{validation_scope:'inner_development',status:'user_selected_exploratory',sample_count:162,prediction_start:'2022-07-01',prediction_end:'2023-03-01',logloss:1.0370499714414905,brier:.6210851680555696,immediate_tp:10,immediate_fp:8,immediate_target:47,immediate_precision:10/18,immediate_recall:10/47,selected_a_mean_bp:4.545049467102099},base_conclusion:{verdict:'尽快',preferred_window:'',narrative:'市场信号给出的发行建议为尽快。'},
 online_run:{runtime:'cloudflare-workflow',model_version:'abcdef0123456789abcd',feature_version:'timing-advice-v1',training_as_of:'2026-10-28',retrain_after:'2026-12-31',workflow_id:'timing-test',input_prefix:'quant-trial/runs/2026-10-28/timing-test'}
};}
export function timingNowcastSnapshot(){return {
 schema_version:'timing-advice-v2',run_id:'00000000-0000-4000-8000-000000000029',generated_at:'2026-10-28T01:00:00Z',as_of_date:'2026-10-28',market_source_date:'2026-10-27',training_label_cutoff:'2026-10-20',model_version:'fedcba9876543210fedc',scope:'AAA证券公司债3Y',
 forecast:{catch_up_bp:-.8,wait_bp:-1.7,wait_quotes:3,threshold_bp:.5},
 probabilities:{defer:.56,wait:.11,issue:.33},decision:{action:'暂缓'},
 validation:{validation_scope:'walk_forward',status:'post_hoc_selected',sample_count:1433,prediction_start:'2021-01-04',prediction_end:'2026-10-19',catch_up_corr:.4653,catch_up_r2:.2193,wait_corr:.1241,spread_bp:1.68,spread_ci_low_bp:.71,spread_ci_high_bp:2.84},
 base_conclusion:{verdict:'暂缓',preferred_window:'',narrative:'预测此后3个报价日利率下行，建议暂缓发行。'},
 online_run:{runtime:'cloudflare-workflow',model_version:'fedcba9876543210fedc',feature_version:'timing-advice-v2',training_as_of:'2026-10-28',retrain_after:'2026-12-31',workflow_id:'nowcast-test',input_prefix:'quant-trial/runs/2026-10-28/nowcast-test'}
};}
export function couponForecastSnapshot(){
 const keys=[['3y-public','3年公募债',3,'证券公司债'],['3y-sub','3年次级债',3,'证券公司次级债'],['5y-public','5年公募债',5,'证券公司债'],['5y-sub','5年次级债',5,'证券公司次级债']];
 const groups=['利率','信用','资金面','基本面','一级发行','二级行情','发行条款'];
 const products=keys.map(([key,label,tenor,bondType],i)=>{
  const anchor=1.58+.07*(tenor-3)/2,median=10+15*(bondType==='证券公司次级债'?1:0)+i*.1,intercept=-1,
   net=[-.1,-.2,.05,-.3,-.05,-1.6,0],detail=[
   {feature:'GOV_3Y_chg5',label:'3Y国债5日变动',group:'利率',value:-2.5,contribution_bp:net[0]},
   {feature:'credit_spread',label:'3Y券商债-国债利差',group:'信用',value:3.1,contribution_bp:net[1]},
   {feature:'DR007',label:'DR007',group:'资金面',value:1.4,contribution_bp:net[2]},
   {feature:'CPI同比',label:'CPI同比',group:'基本面',value:.2,contribution_bp:net[3]},
   {feature:'ISSUE_AMT_5d',label:'5日一级发行额',group:'一级发行',value:2e11,contribution_bp:net[4]},
   {feature:'catch_up_hat',label:'券商债曲线短期走势预测',group:'二级行情',value:-1.6,contribution_bp:net[5]}],
   base=anchor*100+median+intercept,total=net.reduce((a,b)=>a+b,0),coupon=(base+total)/100;
  const dates=['2026-10-28','2026-10-29','2026-10-30','2026-11-02','2026-11-03'];
  return {key,label,tenor,bond_type:bondType,anchor_pct:anchor,issuer_median_bp:median,intercept_bp:intercept,base_coupon_bp:base,deviation_bp:coupon*100-anchor*100,coupon_pct:coupon,n_prior:5,planned_amount_yi:13,
   groups:groups.map((group,j)=>({group,net_bp:net[j]})),contributions:detail,path:dates.map((date,h)=>({date,coupon_percent:coupon-.0003*Math.min(h,3)}))};
 });
 return {schema_version:'coupon-forecast-v3',run_id:'00000000-0000-4000-8000-000000000031',generated_at:'2026-10-28T01:30:00Z',as_of_date:'2026-10-28',market_source_date:'2026-10-27',
  model_version:'0f1e2d3c4b5a69788796',issuer:'东方财富证券股份有限公司',training_label_cutoff:'2026-10-20',timing:{catch_up_bp:-1.6,wait_bp:-3,action:'暂缓'},
  products,validation:{validation_scope:'walk_forward',status:'post_hoc_selected',training_events:671,first_training_event:'2021-02-04',
   development:{start:'2022-01-01',end:'2025-12-31',sample_count:311,mae_bp:7.04,hit_rate_5bp:.585,win_rate_vs_issuer_median:.569},
   holdout:{start:'2026-01-01',end:'2026-10-31',sample_count:62,mae_bp:3.69,hit_rate_5bp:.71,win_rate_vs_issuer_median:.516}},
  base_conclusion:{verdict:'暂缓',preferred_window:'',narrative:'3年公募债预测发行利率1.65%。'},
  online_run:{runtime:'cloudflare-workflow',model_version:'0f1e2d3c4b5a69788796',feature_version:'coupon-forecast-v3',training_as_of:'2026-10-28',retrain_after:'2026-12-31',workflow_id:'coupon-test',input_prefix:'quant-trial/runs/2026-10-28/coupon-test'}};
}
