import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { searchPublicCreditDocuments, requestedRoeAuditYears } = await import('../src/lib/server/credit-search.ts');

const documents = [2023, 2024, 2025].map(year => ({
  key: `credit/public/${year}审计报告.pdf`, title: `${year}审计报告.pdf`,
}));

test('recent ROE retrieves each available audit year from indexed table text, without stored figures', async () => {
  const calls = [];
  const binding = { search: async ({ query, ai_search_options }) => {
    calls.push(query);
    assert.equal(ai_search_options.retrieval.max_num_results, 50);
    const year = Number(query.match(/20\d{2}/)?.[0]);
    return { chunks: [{ id: String(year), item: { key: `credit/public/${year}审计报告.pdf` },
      text: `### Page 110\n加权平均净资产收益率\n归属于公司普通股股东的净利润 ${year - 2000}.37%` }] };
  } };
  const result = await searchPublicCreditDocuments(binding, documents, '近几年的ROE是多少', 12);
  assert.deepEqual(result.requestedYears, [2023, 2024, 2025]);
  assert.deepEqual(result.foundYears, [2023, 2024, 2025]);
  assert.deepEqual(result.chunks.map(chunk => chunk.text.match(/\d+\.37%/)[0]), ['23.37%', '24.37%', '25.37%']);
  assert.deepEqual(calls, [2023, 2024, 2025].map(year => `加权平均净资产收益率 ${year}`));
});

test('missing audit table is reported as missing even if broad results mention another year', async () => {
  const binding = { search: async ({ query }) => ({ chunks: query.includes('2024') ? [] : [{
    item: { key: 'credit/public/2023审计报告.pdf' }, text: '加权平均净资产收益率 归属于公司普通股股东的净利润 9.75%',
  }] }) };
  const result = await searchPublicCreditDocuments(binding, documents, '近三年ROE', 12);
  assert.deepEqual(result.foundYears, [2023]);
  assert.equal(result.searchCalls, 4);
});

test('an indexed audit table can be recovered when semantic ranking omits its final page', async () => {
  const source = documents.filter(document => document.title.startsWith('2023'));
  const binding = {
    search: async () => ({ chunks: [] }),
    items: {
      list: async ({ key }) => ({ result: [{ id: 'audit-item', key, status: 'completed', chunks_count: 82 }] }),
      get: () => ({ chunks: async ({ offset }) => ({ result: offset === 0 ? [
        { id: 'irrelevant', text: '审计意见' },
        { id: 'table', text: '### Page 110\n净资产收益率\n归属于公司普通股股东的净利润 7.63%' },
      ] : [] }) }),
    },
  };
  const result = await searchPublicCreditDocuments(binding, source, '2023年ROE', 12);
  assert.deepEqual(result.foundYears, [2023]);
  assert.equal(result.chunks[0].text.includes('7.63%'), true);
  assert.equal(result.searchCalls, 1);
});

test('ordinary queries retain one broad search and explicit years do not silently use other reports', async () => {
  assert.deepEqual(requestedRoeAuditYears('2024年净资产收益率', documents), [2024]);
  assert.deepEqual(requestedRoeAuditYears('2026年ROE', documents), [2026]);
  const calls = [];
  const binding = { search: async ({ query }) => { calls.push(query); return { chunks: [
    { item: { key: 'credit/public/2025审计报告.pdf' }, text: '公开授信数据' },
    { item: { key: 'credit/private/秘密.pdf' }, text: '不可公开' },
  ] }; } };
  const result = await searchPublicCreditDocuments(binding, documents, '授信额度', 12);
  assert.deepEqual(calls, ['授信额度']);
  assert.equal(result.chunks.length, 1);
});
