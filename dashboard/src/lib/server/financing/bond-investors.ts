import { emptyInvestorAmounts, investorBondType, investorCategories, investorCategory, type InvestorCategorySummary, type InvestorSummary } from '../../financing/bond-investors.ts';

type Database = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }> };

export async function loadBondInvestors(db: Database, asOfDate: string) {
  // Aggregate in Postgres numeric before converting yuan to display units. No account data goes to the browser.
  const { rows } = await db.query(`
    SELECT i.investor_id::text AS id, COALESCE(c.name, '未知') AS name, c.type, c.subtype AS client_subtype,
      b.subtype, sum(i.amount)::text AS total,
      COALESCE(sum(i.amount) FILTER (WHERE b.maturity_date > $1::date
        AND (b.settled_at IS NULL OR b.settled_at > $1::date)
        AND (b.closed_at IS NULL OR b.closed_at > $1::date)), 0)::text AS outstanding
    FROM financing.bond_investors i JOIN financing.bond b ON b.id = i.bond_id
    LEFT JOIN public.client c ON c.id = i.investor_id
    WHERE b.issue_date >= DATE '2020-01-01' AND b.issue_date <= $1::date
    GROUP BY i.investor_id, c.name, c.type, c.subtype, b.subtype
    ORDER BY i.investor_id NULLS LAST, b.subtype`, [asOfDate]);
  const investors = new Map<string, InvestorSummary>();
  const categories: InvestorCategorySummary[] = investorCategories.map(category => ({ category, total: emptyInvestorAmounts(), outstanding: emptyInvestorAmounts() }));
  const total = emptyInvestorAmounts();
  const outstanding = emptyInvestorAmounts();
  for (const row of rows) {
    const bondType = investorBondType(row.subtype);
    if (!bondType) throw new Error(`投资人明细关联了不支持的债券品种：${row.subtype}`);
    const category = investorCategory(row.type, row.client_subtype);
    const key = row.id ?? 'unknown';
    const investor = investors.get(key) ?? { id: row.id, name: row.name, category, total: emptyInvestorAmounts(), outstanding: emptyInvestorAmounts() };
    const categoryRow = categories.find(item => item.category === category)!;
    for (const metric of ['total', 'outstanding'] as const) {
      const value = Number(row[metric]) / 1e8;
      if (!Number.isFinite(value)) throw new Error('投资金额无效');
      for (const amounts of [investor[metric], categoryRow[metric], metric === 'total' ? total : outstanding]) {
        amounts[bondType] += value;
        amounts.total += value;
      }
    }
    investors.set(key, investor);
  }
  const { rows: coverage } = await db.query(`
    WITH allocation AS (SELECT bond_id, sum(amount) AS amount FROM financing.bond_investors GROUP BY bond_id)
    SELECT count(a.bond_id)::integer AS covered_bonds,
      count(*) FILTER (WHERE a.bond_id IS NULL)::integer AS missing_bonds,
      count(*) FILTER (WHERE a.amount IS DISTINCT FROM b.amount AND a.bond_id IS NOT NULL)::integer AS mismatched_bonds,
      COALESCE(sum(b.amount) FILTER (WHERE a.bond_id IS NULL), 0)::text AS missing_amount
    FROM financing.bond b LEFT JOIN allocation a ON a.bond_id = b.id
    WHERE b.issue_date >= DATE '2020-01-01' AND b.issue_date <= $1::date AND b.amount > 0`, [asOfDate]);
  return {
    asOfDate, categories, total, outstanding,
    investors: [...investors.values()].sort((a, b) => b.total.total - a.total.total || a.name.localeCompare(b.name, 'zh-CN')),
    coverage: { coveredBonds: Number(coverage[0]?.covered_bonds ?? 0), missingBonds: Number(coverage[0]?.missing_bonds ?? 0), mismatchedBonds: Number(coverage[0]?.mismatched_bonds ?? 0), missingAmountYi: Number(coverage[0]?.missing_amount ?? 0) / 1e8 }
  };
}
