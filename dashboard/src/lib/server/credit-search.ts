import type { listPublicCreditFiles } from './credit-public-files.ts';

type PublicDocument = Awaited<ReturnType<typeof listPublicCreditFiles>>[number];
type CreditChunk = { id?: string; item: { key: string }; text: string };

const SEARCH_OPTIONS = {
  retrieval: { retrieval_type: 'hybrid' as const, max_num_results: 50, match_threshold: 0 },
  reranking: { enabled: true, model: '@cf/baai/bge-reranker-base', match_threshold: 0 },
  query_rewrite: { enabled: false }, cache: { enabled: false },
};

function availableAuditYears(documents: PublicDocument[]): number[] {
  return documents.flatMap(document => {
    const match = /^(20\d{2})审计报告\.pdf$/.exec(document.title);
    return match ? [Number(match[1])] : [];
  }).sort((a, b) => a - b);
}

export function requestedRoeAuditYears(query: string, documents: PublicDocument[]): number[] {
  if (!/\bROE\b|净资产收益率|净资产回报率/i.test(query)) return [];
  const available = availableAuditYears(documents);
  const explicit = [...new Set([...query.matchAll(/20\d{2}/g)].map(match => Number(match[0])))];
  if (explicit.length === 1) return explicit;
  if (explicit.length > 1) {
    const first = Math.min(...explicit), last = Math.max(...explicit);
    return Array.from({ length: Math.min(last - first + 1, 10) }, (_, index) => first + index);
  }
  const countText = /(?:近|最近)([二三四五2-5])年/.exec(query)?.[1];
  const count = countText ? ({ 二: 2, 三: 3, 四: 4, 五: 5 }[countText as '二' | '三' | '四' | '五'] ?? Number(countText)) : 3;
  return available.slice(-count);
}

function isAnnualRoeTable(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  return compact.includes('净资产收益率') && compact.includes('归属于公司普通股股东的净利润')
    && /\d+(?:\.\d+)?%/.test(compact);
}

async function annualTableFromIndexedItem(binding: Env['CREDIT_SEARCH'], year: number): Promise<CreditChunk[]> {
  const key = `credit/public/${year}审计报告.pdf`;
  const listed = await binding.items.list({ key });
  const item = listed.result.find((candidate: { key: string; status: string }) =>
    candidate.key === key && candidate.status === 'completed');
  if (!item || !item.chunks_count || item.chunks_count > 500) return [];
  const matching: CreditChunk[] = [];
  for (let offset = 0; offset < item.chunks_count; offset += 100) {
    const page = await binding.items.get(item.id).chunks({ offset, limit: 100 });
    matching.push(...page.result.filter((chunk: { text: string }) => isAnnualRoeTable(chunk.text))
      .map((chunk: { id: string; text: string }) => ({
      id: chunk.id, item: { key }, text: chunk.text,
      })));
  }
  return matching.slice(-2);
}

export async function searchPublicCreditDocuments(
  binding: Env['CREDIT_SEARCH'], documents: PublicDocument[], query: string, limit: number,
): Promise<{ chunks: CreditChunk[]; requestedYears: number[]; foundYears: number[]; searchCalls: number }> {
  const publicKeys = new Set(documents.map(document => document.key));
  const years = requestedRoeAuditYears(query, documents);
  const searchableYears = years.filter(year => publicKeys.has(`credit/public/${year}审计报告.pdf`));
  const targeted = await Promise.allSettled(searchableYears.map(async year => {
    const result = await binding.search({ query: `加权平均净资产收益率 ${year}`, ai_search_options: SEARCH_OPTIONS });
    return result.chunks.filter((chunk: CreditChunk) =>
      chunk.item.key === `credit/public/${year}审计报告.pdf` && isAnnualRoeTable(chunk.text)).slice(0, 2);
  }));
  const fromSearch = targeted.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const missingFromSearch = searchableYears.filter(year => !fromSearch.some(chunk =>
    chunk.item.key === `credit/public/${year}审计报告.pdf`));
  const indexed = await Promise.allSettled(missingFromSearch.map(year => annualTableFromIndexedItem(binding, year)));
  const annual = [...fromSearch, ...indexed.flatMap(result => result.status === 'fulfilled' ? result.value : [])]
    .sort((a, b) => a.item.key.localeCompare(b.item.key));
  const found = new Set(annual.map(chunk => Number(/^credit\/public\/(20\d{2})审计报告\.pdf$/.exec(chunk.item.key)?.[1])));
  const needsBroad = years.length === 0 || found.size !== years.length;
  const broad = needsBroad
    ? await binding.search({ query, ai_search_options: SEARCH_OPTIONS }).then((result: { chunks: CreditChunk[] }) => result.chunks).catch((error: unknown) => {
      if (annual.length) return [];
      throw error;
    }) : [];
  const seen = new Set<string>();
  const chunks = [...annual, ...broad].filter((chunk: CreditChunk) => {
    if (!publicKeys.has(chunk.item.key) || !chunk.text.trim()) return false;
    const key = `${chunk.item.key}\n${chunk.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
  return { chunks, requestedYears: years, foundYears: years.filter(year =>
    chunks.some(chunk => chunk.item.key === `credit/public/${year}审计报告.pdf` && isAnnualRoeTable(chunk.text))),
    searchCalls: searchableYears.length + Number(needsBroad) };
}
