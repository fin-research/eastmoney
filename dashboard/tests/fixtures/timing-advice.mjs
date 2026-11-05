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
export function timingNowcastDetailSnapshot(){
 const base=timingNowcastSnapshot(),history=[];
 for(let day=new Date('2026-10-27T00:00:00Z'),i=0;history.length<20;day.setUTCDate(day.getUTCDate()-1),i++){if(day.getUTCDay()%6===0)continue;history.unshift({date:day.toISOString().slice(0,10),yield_pct:Number((1.95-.004*history.length).toFixed(4))});}
 history.forEach((row,i)=>{row.yield_pct=Number((1.9+.004*i).toFixed(4));});
 return {...base,
  forecast:{...base.forecast,source_yield_pct:history.at(-1).yield_pct,decision_quote_date:'2026-10-28',wait_quote_date:'2026-11-02',catch_up_base_bp:-.05,wait_base_bp:-.1},
  history,
  attribution:[
   {group:'sector',catch_up_bp:-.4,wait_bp:-.9},{group:'cdb3',catch_up_bp:-.15,wait_bp:-.3},{group:'gov',catch_up_bp:-.1,wait_bp:-.2},
   {group:'aaa3',catch_up_bp:-.05,wait_bp:-.1},{group:'funding',catch_up_bp:-.05,wait_bp:-.1}]};
}
