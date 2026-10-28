import { handleResearchSearch } from '$lib/server/research-search';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request }) => handleResearchSearch(request);
