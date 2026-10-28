import type { RequestHandler } from './$types';
import { proxyAgentResponses } from '$lib/server/agent-responses';

export const POST: RequestHandler = ({ request, platform, locals }) =>
  proxyAgentResponses(request, platform!.env, locals.user);
