import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/financing/db.js';
import { loadBondInvestors } from '$lib/server/financing/bond-investors';
import { validInvestorDate } from '$lib/financing/bond-investors';

export const load: PageServerLoad = async event => {
  const date = event.url.searchParams.get('date') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (!validInvestorDate(date) || date < '2020-01-01') error(400, '统计日须为2020年起的有效日期');
  event.setHeaders({ 'cache-control': 'no-store' });
  return { report: await loadBondInvestors(getDatabase(event), date) };
};
