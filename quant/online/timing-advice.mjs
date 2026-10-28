import sources from './sources.json' with { type: 'json' };

export const timingFeatureVersion = 'timing-advice-v1';
const paths = ['GOV_1Y','GOV_3Y','GOV_10Y','CDB_3Y','CDB_10Y','AAA_3Y'];
const actions = ['暂缓','等待','尽快'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const quote = value => finite(value) && value !== 0;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;

export function previousTimingQuoteDay(date, calendar) {
  if (!dateValid(date) || Number(date.slice(0,4)) !== calendar.year) throw new Error('Unverified timing calendar year');
  let day = new Date(date);
  for (let count=0;count<40;count++) {
    day.setUTCDate(day.getUTCDate()-1);
    const value = day.toISOString().slice(0,10), part=value.slice(5);
    if (Number(value.slice(0,4)) !== calendar.year) throw new Error('Unverified timing calendar year');
    const closed=calendar.closures.some(([start,end])=>part>=start&&part<=end);
    if ((day.getUTCDay()>0&&day.getUTCDay()<6&&!closed)||calendar.makeup_workdays.includes(part)) return value;
  }
  throw new Error('Timing calendar has no prior quote day');
}

export function validateTimingModel(manifest, model) {
  const names = paths.flatMap(name=>Array.from({length:20},(_,i)=>`path_${name.toLowerCase()}_lag_${i+1}_bp`));
  names.push(...Array.from({length:20},(_,i)=>`path_own_lag_${i+1}_bp`));
  if(manifest.feature_version!==timingFeatureVersion||model.kind!=='linear_timing'
    ||JSON.stringify(model.features)!==JSON.stringify(names)
    ||![model.mean,model.std,model.constant].every(x=>Array.isArray(x)&&x.length===140)
    ||!model.mean.every(finite)||!model.std.every(x=>finite(x)&&x>0)
    ||!model.constant.every(x=>typeof x==='boolean')
    ||!Array.isArray(model.theta)||model.theta.length!==290||!model.theta.every(finite)
    ||!Array.isArray(model.centers)||model.centers.length!==3||!(model.centers[0]<0&&model.centers[1]===0&&model.centers[2]>0))
    throw new Error('Invalid timing model');
}

export function timingFeatures(inputs, names) {
  const date=inputs.as_of_date, source=inputs.required_source_date;
  if(!dateValid(date)||!dateValid(source)||source>=date) throw new Error('Timing inputs must precede decision date');
  const funding=new Map(), sector=new Map(), keys=new Set();
  for(const row of inputs.datasets.funding) {
    if(!dateValid(row.observation_date)||row.observation_date>=date
      ||(row.published_date&&(!dateValid(row.published_date)||row.published_date>=date))) throw new Error('Future timing input');
    const available=[row.observation_date,row.published_date??''].sort().at(-1);
    const key=`${row.field}:${available}`;
    if(keys.has(key)) throw new Error('Duplicate funding quote'); keys.add(key);
    const name=sources.funding[row.field];
    if(!name)throw new Error('Unknown funding field');
    const local=funding.get(available)??{};
    local[name]=row.value;funding.set(available,local);
  }
  for(const row of inputs.datasets.sector3) {
    if(!dateValid(row.observation_date)||row.observation_date>=date) throw new Error('Future timing input');
    if(sector.has(row.observation_date)) throw new Error('Duplicate sector quote');
    sector.set(row.observation_date,row.yield_pct);
  }
  const dates=[...funding.keys()].sort();
  const common=dates.filter(d=>['GOV_1Y','GOV_3Y','GOV_10Y','AAA_3Y'].every(k=>quote(funding.get(d)[k])));
  const own=dates.filter(d=>['GOV_1Y','GOV_3Y','GOV_10Y'].every(k=>quote(funding.get(d)[k]))&&quote(sector.get(d)));
  if(common.at(-1)!==source||own.at(-1)!==source) throw new Error('Stale market quote');
  if(common.length<21||own.length<21) throw new Error('Incomplete timing history');
  const features={};
  for(const name of paths) for(let lag=1;lag<=20;lag++) {
    const previous=funding.get(common.at(-1-lag))[name],current=funding.get(source)[name];
    if(!quote(previous)||!quote(current)) throw new Error('Incomplete timing history');
    features[`path_${name.toLowerCase()}_lag_${lag}_bp`]=(previous-current)*100;
  }
  for(let lag=1;lag<=20;lag++) features[`path_own_lag_${lag}_bp`]=(sector.get(own.at(-1-lag))-sector.get(source))*100;
  const vector=names.map(name=>features[name]);
  if(vector.length!==140||!vector.every(finite)) throw new Error('Incomplete timing history');
  return vector;
}

export function timingProbabilities(model, vector) {
  const z=vector.map((value,i)=>model.constant[i]?0:(value-model.mean[i])/model.std[i]);
  z.push(1,0,0,0,0);
  const logits=[0,0,0];
  for(let i=0;i<145;i++) {logits[0]+=z[i]*model.theta[i*2];logits[2]+=z[i]*model.theta[i*2+1];}
  const maximum=Math.max(...logits), exp=logits.map(x=>Math.exp(x-maximum)), total=exp.reduce((a,b)=>a+b,0);
  return exp.map(x=>x/total);
}

export function inferTiming(manifest, model, inputs) {
  validateTimingModel(manifest,model);
  if(inputs.required_source_date!==previousTimingQuoteDay(inputs.as_of_date,manifest.calendar)) throw new Error('Wrong timing source date');
  const vector=timingFeatures(inputs,model.features),p=timingProbabilities(model,vector);
  const action=actions[p.indexOf(Math.max(...p))];
  return {
    schema_version:timingFeatureVersion,run_id:crypto.randomUUID(),generated_at:new Date().toISOString(),
    as_of_date:inputs.as_of_date,market_source_date:inputs.required_source_date,
    model_version:manifest.model_version,scope:'AAA证券公司债3Y',window_days:30,
    training_label_cutoff:manifest.training_label_cutoff,
    probabilities:{defer:p[0],wait:p[1],issue:p[2]},decision:{action},validation:manifest.validation,
    base_conclusion:{verdict:action,preferred_window:'',narrative:action==='等待'?'模型建议等待。':`模型建议${action}发行。`},
    online_run:{model_version:manifest.model_version,feature_version:timingFeatureVersion,
      training_as_of:manifest.training_as_of,retrain_after:manifest.retrain_after},
  };
}
