import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withBase } from '$lib/financing/app-paths';
export const GET: RequestHandler = async (event) => json({ transport: 'worker', dataApiUrl: new URL(withBase('/data/api'), event.url).toString() },
  { headers: { 'cache-control': 'no-store, private', vary: 'Cookie' } });
