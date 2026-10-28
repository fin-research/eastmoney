// Synthetic encoded-column fixture. No production observations or fitted values.
export function mlpExplanation() {
  const names = ['tenor','issue_size','known_treasury_bp'];
  const quotes = ['sector','issuer'].flatMap(source => Array.from({length:20}, (_, lag) => `${source}_quote_lag_${lag}_bp`));
  names.push(...quotes);
  for (const horizon of [1,14,30]) names.push(`quote_h${horizon}`, ...quotes.map(name => `quote_h${horizon}_${name}`));
  for (const [name,count] of [['issuer',72],['rating',3],['bond_type',2],['placement_type',1]]) {
    names.push(...Array.from({length:count}, (_, index) => `${name}__${index}`));
  }
  const features = names.map((feature,index) => ({feature,value:index%3===0?null:index%3===1?0:1,shap_bp:(index%7-3)/10}));
  return {method:'relu_path_integrated_gradients',unit:'bp',base_coupon_bp:225,
    prediction_coupon_bp:225+features.reduce((sum,row)=>sum+row.shap_bp,0),market_anchor_bp:0,
    issuer_premium_bp:0,horizon_drift_bp:0,tree_expected_change_bp:0,features};
}
