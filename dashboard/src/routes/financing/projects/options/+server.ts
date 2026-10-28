import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProjectFormOptions } from '$lib/server/financing/queries.js';

export const GET: RequestHandler = async () => {
	return json(await getProjectFormOptions(), {
		headers: { 'Cache-Control': 'private, no-store' }
	});
};
