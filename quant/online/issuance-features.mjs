import { fundingFeatures, calendarFeatures, pivot, std } from './features.mjs';
import sources from './sources.json' with { type: 'json' };
import industryProfile from './industry-source.json' with { type: 'json' };
export const industryAvailable = origin => origin > industryProfile.firstPublicationDate;
export function validateIndustryProfile(profile) {
  if(!profile||Object.keys(profile).length!==Object.keys(industryProfile).length||Object.keys(industryProfile).some(key=>profile[key]!==industryProfile[key]))throw new Error('Industry source profile missing or differs from runtime');
}
export const addDays = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
export const dayGap = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
export const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
export const quantile = (values, p) => {
  const xs = values.filter(Number.isFinite).toSorted((a,b) => a-b);
  if (!xs.length) return null;
  const n = (xs.length - 1) * p, i = Math.floor(n);
  return xs[i] + (xs[Math.ceil(n)] - xs[i]) * (n-i);
};
const number = value => value == null ? NaN : Number(value);
const complete = values => values.every(Number.isFinite);
const trailing = (values, i, n, fn) => i + 1 < n || !complete(values.slice(i-n+1,i+1)) ? NaN : fn(values.slice(i-n+1,i+1));
const sum = values => values.reduce((a,b) => a+b, 0);
const delta = (values,i,n) => i < n ? NaN : values[i]-values[i-n];
const dailyRows = rows => {
  if (!rows.length) return [];
  const byDate = new Map(rows.map(row => [row.date,row]));
  const result=[];
  for(let date=rows[0].date; date<=rows.at(-1).date; date=addDays(date,1)) result.push(byDate.get(date)??{date});
  return result;
};
function primaryMarketFeatures(raw) {
  const rows=dailyRows(pivot('primary',raw)), names=['issue_size','issue_count','weighted_cost','net_financing','maturity_amount','redemption_amount'];
  const xs=Object.fromEntries(names.map(name=>[name,rows.map(row=>number(row[name]))]));
  const out=rows.map(row=>({date:row.date}));
  const redemptionPressure=xs.maturity_amount.map((value,index)=>value+xs.redemption_amount[index]);
  for(let i=0;i<rows.length;i++) {
    const row=out[i], size=xs.issue_size, count=xs.issue_count, cost=xs.weighted_cost, net=xs.net_financing, maturity=xs.maturity_amount;
    for(const n of [5,20]) {
      row[`supply_${n}d`]=trailing(size,i,n,sum);
      row[`issue_count_${n}d`]=trailing(count,i,n,sum);
    }
    row.weighted_cost=cost[i];
    const supplyAverage=trailing(size,i,365,mean), supplyDeviation=trailing(size,i,365,std);
    for(const n of [5,20]) {
      row[`supply_${n}d_zscore`]=(row[`supply_${n}d`]-supplyAverage*n)/(supplyDeviation*Math.sqrt(n)+1e-8);
      row[`weighted_cost_chg_${n}d`]=delta(cost,i,n);
    }
    row.net_financing_5d=trailing(net,i,5,sum);
    row.net_financing_20d=trailing(net,i,20,sum);
    row.net_financing_zscore=(row.net_financing_5d-trailing(net,i,365,mean)*5)/(trailing(net,i,365,std)*Math.sqrt(5)+1e-8);
    row.maturity_wall_20d=trailing(maturity,i,20,sum);
    row.redemption_pressure=trailing(redemptionPressure,i,20,sum);
  }
  return out;
}
function secondaryMarketFeatures(raw) {
  const rows=pivot('secondary',raw), vol=rows.map(r=>number(r.VOL));
  const fin=rows.map(r=>number(r.FIN_VOL)), corp=rows.map(r=>number(r.CORP_VOL)), rate=rows.map(r=>number(r.RATE_VOL));
  const credit=fin.map((v,i)=>v+corp[i]);
  return rows.map((r,i)=>{
    const window=vol.slice(Math.max(0,i-59),i+1).filter(Number.isFinite), current=vol[i];
    return {
      date:r.date,
      bond_volume_20d_avg:trailing(vol,i,20,mean),
      bond_volume_chg_5d:delta(vol,i,5),
      bond_volume_pctile_60d:window.length>=20&&Number.isFinite(current)?(current-Math.min(...window))/(Math.max(...window)-Math.min(...window)+1e-8):NaN,
      credit_bond_volume_ratio:vol[i]===0?NaN:credit[i]/vol[i],
      credit_volume_chg_5d:delta(credit,i,5),
      rate_credit_volume_ratio:credit[i]===0?NaN:rate[i]/credit[i],
    };
  });
}
const monthBefore = (period,n) => {
  const [year,month]=period.split('-').map(Number), date=new Date(Date.UTC(year,month-1-n,1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
};
function macroReleaseFeatures(raw, dates) {
  const fields=['GDP','CPI','PPI','PMI','SOCIAL_FINANCE','M2'], byField=new Map(fields.map(name=>[name,[]]));
  for(const row of raw) {
    const name=sources.macro[row.field], value=number(row.value);
    if(!byField.has(name)||!row.published_date||!Number.isFinite(value)) throw new Error('Invalid dated macro release');
    byField.get(name).push({period:row.observation_date.slice(0,7),date:row.observation_date>row.published_date?row.observation_date:row.published_date,value});
  }
  const result=dates.map(date=>({date}));
  for(const name of fields) {
    const releases=byField.get(name).toSorted((a,b)=>a.date.localeCompare(b.date)||a.period.localeCompare(b.period));
    const history=new Map(), datesByPeriod=new Map();
    let j=0, state=null;
    for(let i=0;i<dates.length;i++) {
      while(j<releases.length&&releases[j].date<=dates[i]) {
        const day=releases[j].date;
        while(j<releases.length&&releases[j].date===day) {
          const row=releases[j++]; history.set(row.period,row.value); datesByPeriod.set(row.period,row.date);
        }
        const latest=[...history.keys()].sort().at(-1);
        state={level:history.get(latest),change_1m:history.get(latest)-history.get(monthBefore(latest,1)),change_3m:history.get(latest)-history.get(monthBefore(latest,3)),release_date:datesByPeriod.get(latest)};
      }
      result[i][`macro_${name}_level`]=state?.level??NaN;
      result[i][`macro_${name}_change_1m`]=state?.change_1m??NaN;
      result[i][`macro_${name}_change_3m`]=state?.change_3m??NaN;
      result[i][`macro_${name}_release_age_days`]=state?dayGap(dates[i],state.release_date):NaN;
    }
  }
  return result;
}
function latestAt(rows,date,maxAge=Infinity) {
  let lo=0,hi=rows.length;
  while(lo<hi) {const mid=(lo+hi)>>1; if(rows[mid].date<=date) lo=mid+1; else hi=mid;}
  const found=rows[lo-1];
  return found&&dayGap(date,found.date)<=maxAge?found:null;
}
export function issuanceFeatures(inputs, rawQuotesOnly=false) {
  if(inputs.datasets.industry_curve||inputs.datasets.industry_nodes)validateIndustryProfile(inputs.industry_source_profile);
  const rows = pivot('funding', inputs.datasets.funding).filter(r => r.date >= '2019-01-01');
  if(inputs.datasets.industry_curve) {
    const curve=new Map(inputs.datasets.industry_curve.filter(r=>r.observation_date>=industryProfile.firstPublicationDate).map(r=>[r.observation_date,number(r.yield_pct)]));
    for(const row of rows) row.AAA_3Y=curve.get(row.date)??NaN;
  }
  const columns = ['GOV_1Y', 'GOV_3Y', 'GOV_10Y', 'AAA_3Y'];
  const quotes = rows.filter(r => columns.slice(0,3).every(k => r[k] != null && Number.isFinite(Number(r[k])) && Number(r[k]) !== 0));
  if(rawQuotesOnly)return {quotes,features:quotes.map(r=>({date:r.date,...Object.fromEntries(columns.slice(0,3).map(name=>[`rate_${name.toLowerCase()}_level`,Number(r[name])]))}))};
  const funding = new Map(fundingFeatures(rows).map(r => [r.date, r]));
  const features = quotes.map(r => ({...funding.get(r.date), ...calendarFeatures(r.date)}));
  for (const row of features) row.funding_credit_stress = (row.dr007_pctile_60d - 0.5) + (row.credit_spread_pctile_60d - 0.5);
  for (const name of columns) {
    const xs = quotes.map(r => Number(r[name])), prefix = `rate_${name.toLowerCase()}`;
    for (let i = 0; i < xs.length; i++) {
      const f = features[i];
      f[`${prefix}_level`] = xs[i];
      for (const lag of [1,5,20,60]) f[`${prefix}_change_${lag}`] = (xs[i]-xs[i-lag])*100;
      for (const window of [20,60]) f[`${prefix}_deviation_${window}`] = i+1 < window ? NaN : (xs[i]-mean(xs.slice(i-window+1,i+1)))*100;
      f[`${prefix}_volatility_20`] = i < 20 ? NaN : std(xs.slice(i-19,i+1).map((x,j) => x-xs[i-20+j]))*100;
    }
  }
  if(inputs.datasets.macro) {
    const macro=macroReleaseFeatures(inputs.datasets.macro,quotes.map(r=>r.date));
    for(let i=0;i<features.length;i++) Object.assign(features[i],macro[i]);
  }
  if(inputs.datasets.primary) {
    const primary=new Map(primaryMarketFeatures(inputs.datasets.primary).map(r=>[r.date,r]));
    for(const feature of features) {
      Object.assign(feature,primary.get(feature.date)??{});
      feature.supply_funding_pressure=((Number.isFinite(feature.supply_20d_zscore)?feature.supply_20d_zscore:0)+(Number.isFinite(feature.dr007_pctile_60d)?(feature.dr007_pctile_60d-0.5)*2:0))/2;
    }
  }
  if(inputs.datasets.secondary) {
    const secondary=secondaryMarketFeatures(inputs.datasets.secondary);
    for(const feature of features) {
      const row=latestAt(secondary,feature.date,3);
      if(row) Object.assign(feature,row,{date:feature.date});
      else for(const name of ['bond_volume_20d_avg','bond_volume_chg_5d','bond_volume_pctile_60d','credit_bond_volume_ratio','credit_volume_chg_5d','rate_credit_volume_ratio']) feature[name]=NaN;
    }
  }
  return {quotes, features};
}
export function calendar(spec) {
  const check = date => { if (Number(date.slice(0,4)) !== spec.year) throw new Error('Verified calendar year unavailable'); };
  const closed = new Set(spec.closures.flatMap(([a,b]) => {
    const rows = [];
    for (let d = `${spec.year}-${a}`; d <= `${spec.year}-${b}`; d=addDays(d,1)) rows.push(d);
    return rows;
  }));
  const makeup = new Set(spec.makeup_workdays.map(day => `${spec.year}-${day}`));
  const issuance = date => { check(date); const day = new Date(date).getUTCDay(); return day !== 0 && day !== 6 && !closed.has(date); };
  const quote = date => issuance(date) || makeup.has(date);
  const previous = date => { let d=addDays(date,-1); while (!quote(d)) d=addDays(d,-1); return d; };
  return {issuance,quote,previous};
}
export function matureLabels(quotes, asOf, horizon) {
  const result=[];
  let j=0;
  for (let i=1; i<quotes.length; i++) {
    const deadline=addDays(quotes[i].date,horizon);
    if (deadline>=asOf || deadline>quotes.at(-1).date) continue;
    j=Math.max(j,i);
    while (j+1<quotes.length && quotes[j+1].date<=deadline) j++;
    result.push({date:quotes[i].date, label_end:quotes[j].date, change_bp:(Number(quotes[j].AAA_3Y)-Number(quotes[i-1].AAA_3Y))*100});
  }
  return result;
}
