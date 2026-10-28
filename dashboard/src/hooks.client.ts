import type { HandleClientError } from '@sveltejs/kit';
import { requestLogin, withAuthInteraction } from '$lib/auth-client';

export async function init() {
  const { initializeBearer } = await import('$lib/bearer-auth');
  await initializeBearer(window.fetch.bind(window));
  window.fetch = withAuthInteraction(window.fetch.bind(window), () => window.location.href);
}

export const handleError: HandleClientError = ({ status, event, message }) => {
  if (status === 401) void requestLogin(event.url.pathname + event.url.search + event.url.hash);
  return { message: status === 401 ? '请先登录' : message };
};
