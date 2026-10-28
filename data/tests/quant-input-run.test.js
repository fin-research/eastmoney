import { test, expect, vi, afterEach } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/sync/postgres.ts', () => ({ withPostgres: async (_url, _name, operation) => operation({ query }) }));
vi.mock('../src/sync/broker-curve-sync.ts', () => ({ syncBrokerCurve: vi.fn(async () => ({ stored: 0, missingDates: [], failures: [] })) }));
vi.mock('../src/sync/quant-equity-css.ts', () => ({ syncQuantEquityCss: vi.fn(async () => ({ stored: 0, failures: [], missing: [] })), tradingDates: vi.fn(async () => ['2026-09-15']) }));
import * as curves from '../src/sync/broker-curve-sync.ts';
import * as equity from '../src/sync/quant-equity-css.ts';
import * as history from '../src/sync/bond-history-sync.ts';
import { runQuantInputSync } from '../src/sync/quant-input-run.ts';
import { quantMarketRequests } from '../src/sync/quant-market-sync.ts';
import { observationBucket } from './helpers/issuance-observation-bucket.js';
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

test('paid source errors stay isolated; report read failure is recorded in the partial summary', async () => {
  const configurations = [];
  const step = { do: async (name, config, operation) => {
    if (!operation) return config();
    configurations.push({ name, config });
    return operation();
  } };
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  const request = vi.fn(async () => { throw new Error('Source unavailable'); });
  const bucket = { get: vi.fn(async () => { throw new Error('R2 unavailable'); }) };
  const result = await runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: bucket },
    Date.parse('2026-09-15T16:00:00Z'), request);
  const specs = quantMarketRequests('2026-09-09', '2026-09-15');
  const scheduled = specs.filter(spec => spec.dataset !== 'secondary' && spec.dataset !== 'equity');
  expect(specs.find(spec => spec.id === 'secondary')).toBeDefined();
  expect(request.mock.calls.some(([_path, params]) => params.get('reportName') === 'BondTradingStatistics')).toBe(false);
  expect(request.mock.calls.some(([path]) => path === '/choice/csd')).toBe(false);
  expect(request).toHaveBeenCalledTimes(scheduled.length + 1); // One free, shared quota preflight.
  expect(configurations.every(({ config }) => config.retries.limit === 0)).toBe(true);
  expect(result.status).toBe('partial');
  expect(result.failures).toHaveLength(scheduled.length + 1);
  expect(result.failures.at(-1)).toEqual({ source: 'fund-reports/2026-09-15.html', error: 'R2 unavailable', kind: 'execution' });
  expect(configurations.map(x => x.name).sort()).toEqual(['同步 Quant 权益行情与估值', '同步 Quant 一级市场', '同步 Quant 券商发行与利差', '同步 Quant 资金日报', '同步中债券商曲线', '同步券商存续债估值', '读取已结束上交所交易日', '读取本流程共享CSS额度'].sort());
});


test('business groups run concurrently and primary dates share one fetch-and-upload checkpoint', async () => {
  query.mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO public.quant_input\n')) return { rows: [], rowCount: JSON.parse(params[0]).length };
    return { rows: [], rowCount: 0 };
  });
  const hold = Promise.withResolvers(), primaryDone = Promise.withResolvers();
  const names = [], primaryDays = [];
  const step = { do: async (name, _config, operation) => {
    names.push(name);
    const result = await operation();
    if (name === '同步 Quant 一级市场') primaryDone.resolve();
    return result;
  } };
  const request = async (path, params) => {
    if (path === '/choice/csd') await hold.promise;
    const day = params.get('options')?.match(/StartDate=([^,]+)/)?.[1];
    if (params.get('reportName') === 'BondIssueStatistics') {
      expect(params.get('options')).toContain(`EndDate=${day}`);
      primaryDays.push(day);
      return { function: 'CTR', fields: [], rows: [{ START_DATE: day, END_DATE: day, ISSUE_AMT: 123 }] };
    }
    return { function: path.endsWith('/csd') ? 'CSD' : 'CTR', fields: [], rows: [] };
  };
  const run = runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
    Date.parse('2026-09-15T16:00:00Z'), request);
  await primaryDone.promise;
  expect(names).toContain('同步券商存续债估值');
  expect(names).toHaveLength(8);
  expect(names.filter(name => name === '读取本流程共享CSS额度')).toHaveLength(1);
  expect(primaryDays).toEqual(['2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13','2026-09-14','2026-09-15']);
  const primaryWrites = query.mock.calls.filter(([sql, params]) => sql.startsWith('INSERT INTO public.quant_input\n')
    && JSON.parse(params[0]).some(row => row.dataset === 'primary'));
  expect(primaryWrites).toHaveLength(1);
  expect(JSON.parse(primaryWrites[0][1][0])).toHaveLength(7);
  hold.resolve();
  await run;
});

test('issuance rows commit before missing spread lookup, all within one business checkpoint', async () => {
  const events = [];
  query.mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO public.bond_issuance')) events.push('issue-write');
    if (sql.includes('UPDATE public.bond_issuance SET') && sql.includes('issue_spread_bp=')) events.push('spread-write');
    if (sql.startsWith('COMMIT') && events.includes('issue-write')) events.push('commit');
    if (sql.includes('SELECT bond_code AS code,issue_date::text AS date') && sql.includes('issue_spread_bp IS NULL')) {
      events.push('spread-lookup');
      return { rows: [{ code: '123456.IB', date: '2026-09-15' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const names = [];
  const step = { do: async (name, _config, operation) => { names.push(name); return operation(); } };
  const request = async (path, params) => {
    if (path.endsWith('data-statistics')) return { function:'DATASTATISTICS', rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',
      PERIOD:'W',STARTDATE:'2026-09-14',ENDDATE:'2026-09-20',AVAILABEDATA:1000000}] };
    if (params.get('reportName') === 'BondIssueDetail') return { function: 'CTR', fields: [], rows: [
      { SECUCODE: '123456.IB', ISSUE_DATE: '2026-09-15', ISSUER_NAME:'测试证券', BOND_TYPE: '证券公司债', ACTUAL_ISSUE_SCALE: 10 },
    ] };
    if (path === '/choice/css') {
      events.push('spread-fetch');
      return { function: 'CSS', fields: [], rows: [{ code: '123456.IB', ISSUECREDITSPREAD: 42 }] };
    }
    return { function: path.endsWith('/csd') ? 'CSD' : 'CTR', fields: [], rows: [] };
  };
  await runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: observationBucket() },
    Date.parse('2026-09-15T16:00:00Z'), request);
  expect(events.indexOf('commit')).toBeGreaterThan(events.indexOf('issue-write'));
  expect(events.indexOf('spread-lookup')).toBeGreaterThan(events.indexOf('commit'));
  expect(events.indexOf('spread-fetch')).toBeGreaterThan(events.indexOf('spread-lookup'));
  expect(events.indexOf('spread-write')).toBeGreaterThan(events.indexOf('spread-fetch'));
  expect(names.filter(name => name.includes('发行'))).toEqual(['同步 Quant 券商发行与利差']);
});

test('primary CTR only requests missing dates; existing partial dates are reported without another paid query', async () => {
  const days = Array.from({ length: 7 }, (_, i) => `2026-09-${String(i + 9).padStart(2, '0')}`);
  const fields = quantMarketRequests(days[0], days.at(-1)).find(spec => spec.dataset === 'primary').fields;
  query.mockImplementation(async (sql) => {
    if (sql.includes('array_agg(DISTINCT field')) return { rows: days.filter(day => day !== '2026-09-15').map(date => ({
      date, fields: ['2026-09-13', '2026-09-14'].includes(date) ? fields.filter(field => field !== 'WEIGHTED_COST') : fields,
      issue_count: date === '2026-09-13' ? '0' : '1',
    })), rowCount: 7 };
    return { rows: [], rowCount: 0 };
  });
  const called = [], checkpoints = [];
  const step = { do: async (name, _config, operation) => {
    const result = await operation(); checkpoints.push({ name, result }); return result;
  } };
  const request = async (path, params) => {
    if (params.get('reportName') === 'BondIssueStatistics') {
      called.push(params.get('options'));
      return { function: 'CTR', fields: [], rows: [{ START_DATE: '2026-09-15', END_DATE: '2026-09-15',
        ...Object.fromEntries(fields.filter(field => field !== 'WEIGHTED_COST').map(field => [field, field === 'ISSUE_NUM' ? 0 : 1])) }] };
    }
    return { function: path.endsWith('/csd') ? 'CSD' : 'CTR', fields: [], rows: [] };
  };
  const result = await runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
    Date.parse('2026-09-15T16:00:00Z'), request);
  expect(called).toHaveLength(1);
  expect(called[0]).toContain('StartDate=2026-09-15,EndDate=2026-09-15');
  const primary = checkpoints.find(item => item.name === '同步 Quant 一级市场').result;
  expect(primary.requestedDates).toEqual(['2026-09-15']);
  expect(primary.skippedDates).toHaveLength(6);
  expect(primary.missing).toEqual([{ source: 'primary-2026-09-14', dates: ['2026-09-14'], fields: ['WEIGHTED_COST'], reason: 'stored_fields_incomplete' }]);
  expect(primary.failures).toEqual([{ source: 'primary-2026-09-14', error: 'Stored date has missing fields: WEIGHTED_COST', kind: 'data_gap' }]);
  expect(result.groups.find(item => item.name === '同步 Quant 一级市场')).toEqual(primary);
  expect(result.missing).toContainEqual(primary.missing[0]);
});

test('primary coverage read failure never falls back to charging every date', async () => {
  query.mockImplementation(async sql => {
    if (sql.includes('array_agg(DISTINCT field')) throw new Error('coverage database unavailable');
    return { rows: [], rowCount: 0 };
  });
  const request = vi.fn(async path => ({ function: path.endsWith('/csd') ? 'CSD' : 'CTR', fields: [], rows: [] }));
  const step = { do: async (_name, _config, operation) => operation() };
  const result = await runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
    Date.parse('2026-09-15T16:00:00Z'), request);
  expect(request.mock.calls.some(([_path, params]) => params.get('reportName') === 'BondIssueStatistics')).toBe(false);
  expect(result.groups.find(item => item.name === '同步 Quant 一级市场')).toMatchObject({ status: 'partial', failures: [
    { source: '同步 Quant 一级市场', error: 'coverage database unavailable' },
  ] });
});

test('midnight issuance stops at the completed day; an empty detail window is valid, empty statistics remain missing', async () => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  const request = vi.fn(async (_path, params) => {
    if (params.get('reportName') === 'BondIssueDetail') throw new Error('10000009 no data');
    return { function: 'CTR', fields: [], rows: [] };
  });
  const result = await runQuantInputSync({ do: async (_name, _config, operation) => operation() },
    { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
    Date.parse('2026-10-01T16:00:00Z'), request);
  const options = request.mock.calls.map(([_path, params]) => params.get('options'));
  expect(options.some(value => value?.includes('2026-10-02'))).toBe(false);
  expect(options.some(value => value?.includes('StartDate=2026-09-25,EndDate=2026-10-01'))).toBe(true);
  expect(result.failures.some(item => item.source === 'issue')).toBe(false);
  expect(result.missing.some(item => item.source === 'issue')).toBe(false);
  expect(result.failures).toContainEqual({ source: 'primary-2026-10-01', error: 'No observations returned', kind: 'data_gap' });
});

test.each(['ok','archive-failed','database-failed'])('live observations preserve paid calls and independent database outcomes: %s',async mode=>{
 const bucket=observationBucket();
 if(mode==='archive-failed'){
  const put=bucket.put.getMockImplementation();
  bucket.put.mockImplementation((key,...args)=>key.startsWith('data-observations/css-budget/')?put(key,...args):Promise.reject(Error('archive unavailable')));
 }
 const fields=quantMarketRequests('2026-09-26','2026-10-02').find(s=>s.dataset==='primary').fields;
 const bond={code:'123456.SH',date:'2026-10-02'};let writes=0;
 query.mockImplementation(async(sql,params)=>{
  if(sql.includes('array_agg(DISTINCT field'))return{rows:Array.from({length:7},(_,i)=>({date:`2026-${i<5?'09-'+(26+i):'10-0'+(i-4)}`,fields,issue_count:1})),rowCount:7};
  if(sql.includes('pricing_invalid_code=false')&&sql.includes('LIMIT 64'))return{rows:[bond],rowCount:1};
  if(sql.includes('placement_checked_at IS NULL'))return{rows:[bond],rowCount:1};
  if(sql.startsWith('INSERT INTO public.bond_issuance')||sql.startsWith('UPDATE public.bond_issuance SET')){
   if(mode==='database-failed'&&sql.includes('tender_date=coalesce'))throw Error('database unavailable');
   writes++;return{rows:[],rowCount:1};
  }
  return{rows:[],rowCount:0};
 });
 const paid=[];
 const request=vi.fn(async(path,q)=>{
  if(path.endsWith('data-statistics'))return{function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-09-28',ENDDATE:'2026-10-04',AVAILABEDATA:1000000}]};
  paid.push({path,parameters:Object.fromEntries(q)});
  if(q.get('reportName')==='BondIssueDetail')return{function:'CTR',fields:[],rows:[{SECUCODE:bond.code,ISSUE_DATE:bond.date,ISSUER_NAME:'测试证券',BOND_TYPE:'证券公司债'}]};
  if(q.get('indicators').includes('TENDERDATE'))return{function:'CSS',rows:[{code:bond.code,TENDERDATE:'2026/10/1',TENDERFINALCOUPON:2.1,ISSCORPCREDITRAT:'AAA',TENDERANNCDATE:'2026/9/28'}]};
  if(q.get('indicators').includes('RAISEWAY'))return{function:'CSS',rows:[{code:bond.code,RAISEWAY:'公募',MATURITYDATE:'2029-10-02'}]};
  throw Error('Unexpected extra paid query');
 });
 const step={do:async(_name,config,operation)=>{expect(config.retries.limit).toBe(0);return operation();}};
 const result=await runQuantInputSync(step,{HYPERDRIVE:{connectionString:'test'},EASTMONEY:bucket},Date.parse('2026-10-02T16:00:00Z'),request,`live-${mode}`);
 expect(paid.map(p=>p.path)).toEqual(['/choice/ctr','/choice/css','/choice/css']);
 const issuer=result.groups.find(g=>g.name==='同步 Quant 券商发行与利差');
 expect(issuer.observations).toHaveLength(3);
 if(mode==='archive-failed'){
  expect(issuer.observations.every(o=>o.status==='failed')).toBe(true);expect(writes).toBeGreaterThan(0);
  expect(issuer.failures.some(f=>f.source.startsWith('observation-archive:'))).toBe(true);
 }else{
  expect(issuer.observations.every(o=>o.status==='archived')).toBe(true);
  expect(bucket.objects.has(issuer.application_receipt)).toBe(true);
  if(mode==='database-failed')expect(issuer.failures).toContainEqual({source:'issue-pricing',error:'database unavailable',kind:'execution'});
 }
});


test('history waits for issuance while a pending curve does not block it', async () => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  const curveHold = Promise.withResolvers(), issueHold = Promise.withResolvers();
  const primaryDone = Promise.withResolvers();
  curves.syncBrokerCurve.mockImplementationOnce(async () => { await curveHold.promise; return { stored: 1, missingDates: [], failures: [] }; });
  const historyCall = vi.spyOn(history, 'syncBondHistory').mockResolvedValue({ stored: 0, failures: [], missing: [] });
  const request = async (_path, params) => {
    if (params.get('reportName') === 'BondIssueDetail') await issueHold.promise;
    return { function: 'CTR', fields: [], rows: [] };
  };
  const step = { do: async (name, _config, operation) => {
    const result = await operation();
    if (name === '同步 Quant 一级市场') primaryDone.resolve();
    return result;
  } };
  const pending = runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
    Date.parse('2026-09-15T16:00:00Z'), request);
  await primaryDone.promise;
  expect(historyCall).not.toHaveBeenCalled();
  issueHold.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(historyCall).toHaveBeenCalledOnce();
  expect(historyCall.mock.calls[0][3]).toEqual(['2026-09-15']);
  curveHold.resolve();
  await pending;
});

test('equity waits for macro persistence and still runs after a failed curve group', async () => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  const ready = Promise.withResolvers(), primaryDone = Promise.withResolvers();
  const before = equity.syncQuantEquityCss.mock.calls.length;
  curves.syncBrokerCurve.mockRejectedValueOnce(new Error('curve unavailable'));
  const step = { do: async (name, _config, operation) => {
    const result = await operation();
    if (name === '同步 Quant 一级市场') primaryDone.resolve();
    return result;
  } };
  const pending = runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
    Date.parse('2026-09-15T16:00:00Z'), async () => ({ function: 'CTR', fields: [], rows: [] }), undefined, ready.promise);
  await primaryDone.promise;
  expect(equity.syncQuantEquityCss.mock.calls).toHaveLength(before);
  ready.resolve();
  const result = await pending;
  expect(equity.syncQuantEquityCss.mock.calls).toHaveLength(before + 1);
  expect(result.groups.find(g => g.name === '同步中债券商曲线').failures[0].error).toBe('curve unavailable');
});

test('history reuses persisted fund calendar on Workflow resume without another calendar fetch', async () => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  const historyCall = vi.spyOn(history, 'syncBondHistory').mockResolvedValue({ stored: 0, failures: [], missing: [] });
  const before = equity.tradingDates.mock.calls.length;
  const bucket = { get: vi.fn(async () => null) };
  const step = { do: async (name, _config, operation) => name === '读取已结束上交所交易日'
    ? ['2026-09-03', '2026-09-09', '2026-09-15'] : operation() };
  await runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: bucket },
    Date.parse('2026-09-15T16:00:00Z'), async () => ({ function: 'CTR', rows: [] }));
  expect(equity.tradingDates.mock.calls).toHaveLength(before);
  expect(historyCall.mock.calls[0][3]).toEqual(['2026-09-09', '2026-09-15']);
  expect(bucket.get.mock.calls.map(([key]) => key)).toEqual([
    'fund-reports/2026-09-03.html', 'fund-reports/2026-09-09.html', 'fund-reports/2026-09-15.html',
  ]);
});

test('failed or empty durable calendar reports partial and never starts history CSS', async () => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  for (const value of [null, []]) {
    const historyCall = vi.spyOn(history, 'syncBondHistory');
    const step = { do: async (name, _config, operation) => {
      if (name === '读取已结束上交所交易日' && value === null) throw new Error('calendar unavailable');
      if (name === '读取已结束上交所交易日') return value;
      return operation();
    } };
    const result = await runQuantInputSync(step, { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: { get: async () => null } },
      Date.parse('2026-09-15T16:00:00Z'), async () => ({ function: 'CTR', rows: [] }));
    expect(result.groups.find(group => group.name === '同步券商存续债估值')).toMatchObject({ status: 'partial', stored: 0 });
    expect(historyCall).not.toHaveBeenCalled();
    historyCall.mockRestore();
  }
});
