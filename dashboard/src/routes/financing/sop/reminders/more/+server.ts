import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getReminderHistory } from '$lib/server/financing/queries.js';

export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') ?? '';
	const query = url.searchParams.get('query')?.trim() ?? '';
	const cursor = url.searchParams.get('cursor');
	const history = await getReminderHistory({
		status,
		query,
		cursor,
		limit: 50,
		includeSummary: false
	});
	return json({
		rows: history.rows,
		hasMore: history.hasMore,
		nextCursor: history.nextCursor
	});
};
