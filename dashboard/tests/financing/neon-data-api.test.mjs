import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadNeonDataApi() {
	const source = await readFile(new URL('../../src/lib/financing/neon-data-api.ts', import.meta.url), 'utf8');
	const isolated = source.replace(
		"import { withBase } from './app-paths';",
		"const withBase = (path) => `/financing${path}`;"
	).replace(
		"import { LIABILITY_REPORT_EDB_CODES } from './liability-report-data.js';",
		"const LIABILITY_REPORT_EDB_CODES = ['E1707781', 'E1000172'];"
	);
	const output = ts.transpileModule(isolated, {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
	}).outputText;
	return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#${Date.now()}`);
}

const entity = {
	tableName: 'debt',
	fields: [{ key: 'id' }],
	primaryKeys: ['id'],
	searchFields: []
};

const listOptions = {
	page: 0,
	pageSize: 50,
	sortKey: 'id',
	sortDirection: 'asc',
	search: ''
};

test('monthly financial writes return one dated entity and reject stale updates', async () => {
	const { NeonDataApi } = await loadNeonDataApi();
	const originalFetch = globalThis.fetch;
	const calls = [];
	const config = { ...entity, tableName: 'financial_monthly_data', primaryKeys: ['period_end'] };
	const row = { total_assets: 1500, period_end: '2026-08-31', updated_at: '2026-09-07T08:00:00Z' };
	globalThis.fetch = async (input, init = {}) => {
		if (String(input) === '/financing/data/token') return Response.json({ token: 'test', dataApiUrl: 'https://data.example.test' });
		calls.push({ url: new URL(input), ...init });
		return Response.json(init.method === 'POST' ? [row] : []);
	};
	try {
		const api = new NeonDataApi();
		assert.deepEqual(await api.insert(config, { period_end: row.period_end, total_assets: 1500 }), [row]);
		await assert.rejects(api.update(config, row, { total_assets: 1600 }), /已被其他人修改/);
		assert.deepEqual(calls.map((call) => call.method), ['POST', 'PATCH']);
		assert.equal(calls[1].url.searchParams.get('period_end'), 'eq.2026-08-31');
		assert.equal(calls[1].url.searchParams.get('updated_at'), `eq.${row.updated_at}`);
		assert.equal(new Headers(calls[0].headers).get('Prefer'), 'return=representation');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('data client obtains and reuses the token and HTTPS endpoint together', async () => {
	const { NeonDataApi } = await loadNeonDataApi();
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		calls.push({ url, headers: new Headers(init.headers) });
		if (url === '/financing/data/token') {
			return Response.json({ token: 'token-one', dataApiUrl: 'https://data.example.test/' });
		}
		return new Response(JSON.stringify([{ id: 1 }]), {
			headers: { 'content-type': 'application/json', 'content-range': '0-0/1' }
		});
	};

	try {
		const api = new NeonDataApi();
		assert.deepEqual(await api.list(entity, listOptions), { rows: [{ id: 1 }], total: 1 });
		assert.deepEqual(await api.list(entity, listOptions), { rows: [{ id: 1 }], total: 1 });
		assert.equal(calls.filter((call) => call.url === '/financing/data/token').length, 1);
		assert.match(calls[1].url, /^https:\/\/data\.example\.test\/debt\?/);
		assert.equal(calls[1].headers.get('authorization'), 'Bearer token-one');
		assert.equal(calls[1].headers.get('accept-profile'), 'financing');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('data client refreshes both token and endpoint once after a 401', async () => {
	const { NeonDataApi } = await loadNeonDataApi();
	const originalFetch = globalThis.fetch;
	const apiCalls = [];
	let tokenCalls = 0;
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		if (url === '/financing/data/token') {
			tokenCalls += 1;
			return Response.json({
				token: `token-${tokenCalls}`,
				dataApiUrl: `https://data-${tokenCalls}.example.test`
			});
		}
		apiCalls.push({ url, authorization: new Headers(init.headers).get('authorization') });
		if (apiCalls.length === 1) return new Response('{}', { status: 401 });
		return new Response(JSON.stringify([{ id: 2 }]), {
			headers: { 'content-type': 'application/json', 'content-range': '0-0/1' }
		});
	};

	try {
		const api = new NeonDataApi();
		assert.deepEqual(await api.list(entity, listOptions), { rows: [{ id: 2 }], total: 1 });
		assert.equal(tokenCalls, 2);
		assert.deepEqual(apiCalls, [
			{ url: apiCalls[0].url, authorization: 'Bearer token-1' },
			{ url: apiCalls[1].url, authorization: 'Bearer token-2' }
		]);
		assert.match(apiCalls[0].url, /^https:\/\/data-1\.example\.test\/debt\?/);
		assert.match(apiCalls[1].url, /^https:\/\/data-2\.example\.test\/debt\?/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('liability report fetches business and raw EDB data in parallel with one authenticated session', async () => {
	const { NeonDataApi } = await loadNeonDataApi();
	const originalFetch = globalThis.fetch;
	const calls = [];
	let tokenCalls = 0;
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		if (url === '/financing/data/token') {
			tokenCalls += 1;
			return Response.json({ token: 'report-token', dataApiUrl: 'https://data.example.test' });
		}
		calls.push({ url, method: init.method, headers: new Headers(init.headers), body: init.body });
		return url.includes('/rpc/')
			? Response.json({ version: 1, report: { asOfDate: '2026-09-03' }, limits: [] })
			: Response.json([{ indicator_code: 'E1707781', observation_date: '2026-09-02', value: 2.1 }]);
	};
	try {
		const api = new NeonDataApi();
		const [business, marketRates] = await Promise.all([
			api.liabilityWeeklyReportBusiness('2026-09-03'),
			api.liabilityMarketRates('2026-09-03')
		]);
		assert.equal(business.version, 1);
		assert.equal(marketRates.length, 1);
		assert.equal(tokenCalls, 1);
		assert.equal(calls.length, 2);
		const businessCall = calls.find((call) => call.url.includes('/rpc/'));
		assert.equal(businessCall.url, 'https://data.example.test/rpc/liability_weekly_report_data');
		assert.equal(businessCall.method, 'POST');
		assert.equal(businessCall.headers.get('content-profile'), 'financing');
		assert.equal(businessCall.body, JSON.stringify({ p_report_date: '2026-09-03' }));
		const marketCall = calls.find((call) => call.url.includes('/liability_market_rate_observations?'));
		const marketUrl = new URL(marketCall.url);
		assert.equal(marketUrl.searchParams.get('select'), 'indicator_code,observation_date,value');
		assert.equal(marketUrl.searchParams.get('indicator_code'), 'in.(E1707781,E1000172)');
		assert.deepEqual(marketUrl.searchParams.getAll('observation_date'), ['gte.2026-01-01', 'lte.2026-09-03']);
		assert.equal(marketUrl.searchParams.get('limit'), '5000');
		await assert.rejects(api.liabilityWeeklyReportBusiness('invalid'), /日期无效/);
		await assert.rejects(api.liabilityMarketRates('invalid'), /日期无效/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('debt export freshly fetches all pages with identical filters and stable sorting; editor scopes id to product',async()=>{
 const {NeonDataApi}=await loadNeonDataApi();const previous=globalThis.fetch;const calls=[];
 const config={...entity,fields:[{key:'id'},{key:'name'}],fixedValues:{debt_type:'债券',subtype:'小公募'}};
 globalThis.fetch=async(input)=>{
  if(String(input)==='/financing/data/token')return Response.json({token:'x',dataApiUrl:'https://data.example.test'});
  const url=new URL(input);calls.push(url);
  const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit'));
  return Response.json(limit===1?[{id:9}]:Array.from({length:Math.min(500,501-offset)},(_,i)=>({id:offset+i})),{headers:{'content-range':`${offset}-${Math.min(500,501-offset)}/501`}});
 };
 try {
 const api=new NeonDataApi();const rows=await api.all(config,{...listOptions,sortKey:'name',sortDirection:'desc',lifecycle:'unmatured',asOfDate:'2026-10-16',search:'foo'});
 assert.equal(rows.length,501);assert.equal(calls.length,2);
 for(const url of calls){assert.equal(url.searchParams.get('lifecycle'),'unmatured');assert.equal(url.searchParams.get('as_of'),'2026-10-16');assert.equal(url.searchParams.get('order'),'name.desc.nullslast,id.desc.nullslast');assert.equal(url.searchParams.get('subtype'),'eq.小公募');}
 await api.get(config,'9');assert.equal(calls[2].searchParams.get('id'),'eq.9');assert.equal(calls[2].searchParams.get('subtype'),'eq.小公募');
 }finally{globalThis.fetch=previous;}
});

test('export rejects changed counts or duplicate identities rather than exporting partial results',async()=>{
 const {NeonDataApi}=await loadNeonDataApi();const previous=globalThis.fetch;
 try{
  for(const mode of ['changed','duplicate']){
   let calls=0;
   globalThis.fetch=async(input)=>{
    if(String(input)==='/financing/data/token')return Response.json({token:'x',dataApiUrl:'https://data.example.test'});
    const page=calls++;return Response.json(page===0?Array.from({length:500},(_,id)=>({id})):[{id:mode==='duplicate'?499:500}],{headers:{'content-range':`0-0/${mode==='changed'&&page?502:501}`}});
   };
   await assert.rejects(new NeonDataApi().all(entity,listOptions),/数据已变化/);
  }
 }finally{globalThis.fetch=previous;}
});

test('fixed product subtype cannot be overridden by URL options',async()=>{
 const {NeonDataApi}=await loadNeonDataApi();const previous=globalThis.fetch;let observed;
 globalThis.fetch=async(input)=>{
  if(String(input)==='/financing/data/token')return Response.json({token:'x',dataApiUrl:'https://data.example.test'});
  observed=new URL(input);return Response.json([]);
 };
 try{await new NeonDataApi().list({...entity,fixedValues:{debt_type:'债券',subtype:'小公募'}},{...listOptions,subtype:'次级债'});assert.equal(observed.searchParams.get('subtype'),'eq.小公募');}finally{globalThis.fetch=previous;}
});
