import { handleDashboardMcp } from '$lib/server/mcp';
import type { RequestHandler } from './$types';
const handle: RequestHandler = ({ request, platform, locals }) => handleDashboardMcp(request, platform!.env, locals.user);
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
