import { redirect, type Handle } from '@sveltejs/kit';
import { AccessError } from '$lib/server/access';
import { loginUrl } from '$lib/auth-navigation';
import { dashboardAccessFailure } from '$lib/server/dashboard-access';
import { gatewayContext } from '$lib/server/gateway-context';
import { closeDatabase } from '$lib/server/financing/db.js';
import { withReminderCheckpointInvalidation } from '$lib/server/financing/reminder-checkpoint.js';

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.database = null;
  event.locals.permissions = [];
  try {
    if (!event.platform?.env) return new Response('身份服务暂时不可用', { status: 503 });
    try {
      const authorization = gatewayContext(event.platform.env);
      event.locals.user = authorization.user;
      event.locals.permissions = authorization.permissions;
    } catch (failure) {
      if (event.isDataRequest && failure instanceof AccessError && failure.status === 401) redirect(303, loginUrl(event.url.pathname + event.url.search));
      return dashboardAccessFailure(event.request, failure);
    }
    const financingWrite = !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)
      && (event.url.pathname === '/financing' || event.url.pathname.startsWith('/financing/'));
    // Await both invalidations so a scan racing with a mutation cannot extend an
    // old empty result. A failed mutation must also leave the next scan enabled.
    const response = financingWrite
      ? await withReminderCheckpointInvalidation(event.platform.env.DB, () => resolve(event))
      : await resolve(event);
    if (response.status === 401) {
      if (event.isDataRequest) redirect(303, loginUrl(event.url.pathname + event.url.search));
      return dashboardAccessFailure(event.request, new AccessError(401, '请先登录'));
    }
    if (event.locals.user || event.locals.permissions.length) {
      response.headers.set('Cache-Control', 'no-store, private');
      response.headers.append('Vary', 'Authorization');
    }
    return response;
  } finally { await closeDatabase(event); }
};
