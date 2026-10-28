import { test, expect, vi, afterEach } from 'vitest';
const { query, fetchChoiceTable } = vi.hoisted(() => ({ query: vi.fn(), fetchChoiceTable: vi.fn() }));
vi.mock('../src/sync/postgres.ts', () => ({ withPostgres: async (_url, _name, operation) => operation({ query }) }));
vi.mock('../src/choice/client.ts', () => ({ fetchChoiceTable }));
import { syncQuantEquityCss } from '../src/sync/quant-equity-css.ts';
afterEach(() => vi.clearAllMocks());

const env = { HYPERDRIVE: { connectionString: 'test' } };

test('CSS sync requests only missing fields on confirmed trading dates and inserts without replacing CSD values', async () => {
  const codes = ['000001.SH','399001.SZ','000300.SH','000852.SH','399006.SZ','000688.SH','800004.EI'];
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM public.quant_input WHERE observation_date BETWEEN')) return { rows: [
      { date: '2026-09-24', fields: ['sse_close'] },
    ] };
    if (sql.includes('FROM public.edb')) return { rows: [{ date: '2026-09-24', value: '1.6738' }] };
    if (sql.startsWith('INSERT INTO public.quant_input\n')) return { rowCount: JSON.parse(params[0]).length, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  fetchChoiceTable.mockImplementation(async (_env, method, payload) => {
    expect(method).toBe('tradedates');
    return { function: 'TRADEDATES', rows: payload.options.includes('CNSESH')
      ? [{ date: '2026-09-24' }] : [{ date: '2026-09-24' }, { date: '2026-09-25' }] };
  });
  const paths = [];
  const request = vi.fn(async (path, params) => {
    paths.push([path, params]);
    if (path === '/choice/data-statistics') return { function: 'DATASTATISTICS', rows: [
      { FUNCENAME: 'EM_CSS', SECUTYPE: '全品种', PERIOD: 'W', STARTDATE: '2026-09-20', ENDDATE: '2026-09-27', AVAILABEDATA: '200000' },
    ] };
    const requested = params.get('codes').split(',');
    const indicators = params.get('indicators').split(',');
    return { function: 'CSS', rows: requested.map((code, index) => ({ code,
      ...Object.fromEntries(indicators.map(indicator => [indicator, indicator === 'PETTM' ? 21.474 : index + 1])) })) };
  });
  const result = await syncQuantEquityCss(env, request, '2026-09-20', '2026-09-27');
  expect(result.failures).toEqual([]);
  expect(result.stored).toBe(13);
  expect(paths.filter(([path]) => path === '/choice/css')).toHaveLength(4);
  expect(paths.filter(([path, params]) => path === '/choice/css' && params.get('options').includes('2026-09-25'))).toHaveLength(1);
  const domestic = paths.find(([path, params]) => path === '/choice/css' && params.get('options') === 'TradeDate=2026-09-24' && params.get('codes').includes('399001.SZ'));
  expect(domestic[1].get('codes')).toBe(codes.slice(1).join(','));
  const inserts = query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO public.quant_input\n'));
  expect(inserts).toHaveLength(1);
  expect(inserts[0][0]).toContain('ON CONFLICT (field,observation_date) DO NOTHING');
  const rows = JSON.parse(inserts[0][1][0]);
  expect(rows).not.toContainEqual(expect.objectContaining({ field: 'sse_close' }));
  expect(rows).toContainEqual(expect.objectContaining({ field: 'equity_bond_spread', observationDate: '2026-09-24',
    numericValue: 2.982994, source: 'choice-api-css+edb' }));
});

test('CSS quota shortfall stops paid calls and reports the planned gaps', async () => {
  query.mockImplementation(async sql => sql.includes('FROM public.quant_input WHERE observation_date BETWEEN')
    ? { rows: [] } : { rows: [], rowCount: 0 });
  fetchChoiceTable.mockImplementation(async (_env, _method, payload) => ({ function: 'TRADEDATES',
    rows: payload.options.includes('CNSESH') ? [{ date: '2026-09-24' }] : [] }));
  const request = vi.fn(async () => ({ function: 'DATASTATISTICS', rows: [
    { FUNCENAME: 'EM_CSS', SECUTYPE: '全品种', PERIOD: 'W', STARTDATE: '2026-09-20', ENDDATE: '2026-09-27', AVAILABEDATA: '12' },
  ] }));
  const result = await syncQuantEquityCss(env, request, '2026-09-20', '2026-09-27');
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.failures).toEqual([{ source: 'equity-css-quota', error: 'CSS quota unavailable or below reserved budget' }]);
  expect(result.missing).toHaveLength(3);
});
