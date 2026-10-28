import type { RequestHandler } from './$types';
import { identityRequest } from '$lib/server/gateway-client';
import { readProfileJson } from '$lib/server/profile';
export const GET: RequestHandler = ({ locals, platform }) => identityRequest(platform!.env, '/api/profile', locals.user);
export const POST: RequestHandler = async ({ locals, platform, request }) => identityRequest(platform!.env, '/api/profile', locals.user, await readProfileJson(request, 4096));
