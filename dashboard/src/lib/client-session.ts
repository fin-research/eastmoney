import { writable } from 'svelte/store';
import { publicSession, type ClientSessionData } from './identity.ts';

export const CLIENT_SESSION_CONTEXT = 'site-session';
export type ClientSession = ReturnType<typeof createClientSession>;

/** Owned by one root layout, so SSR requests never share a user's snapshot. */
export function createClientSession(
  initial: ClientSessionData | null = null,
  loader: (force: boolean) => Promise<ClientSessionData> = async force => {
    const { loadBearerSession } = await import('./bearer-auth.ts');
    return loadBearerSession(force);
  },
  now: () => number = Date.now,
) {
  let value = initial;
  let revision = 0;
  let pending: Promise<ClientSessionData> | null = null;
  const store = writable(value);
  function seed(next: ClientSessionData) {
    revision++;
    value = next;
    store.set(next);
  }
  function seedFromServer(next: ClientSessionData) {
    // A page load is not a new login. Keep the login's presentation permissions
    // until a new token/session or an explicit refresh supplies a new snapshot.
    if (value?.user && next.user?.id === value.user.id && next.expiresAt === value.expiresAt) return;
    seed(next);
  }
  function current() {
    if (value?.user && (!value.expiresAt || value.expiresAt * 1000 <= now())) return null;
    return value;
  }
  function load(force = false): Promise<ClientSessionData> {
    const cached = current();
    if (!force && cached) return Promise.resolve(cached);
    if (pending) return pending;
    const startedAt = revision;
    pending = (async () => {
      let session = await loader(force);
      // JWT verification has clock tolerance; never resume navigation with an
      // already-expired snapshot and enter an endless refresh/goto cycle.
      if (session.user && session.expiresAt! * 1000 <= now()) session = publicSession(null);
      // A late public-page request must not replace a newer SSR/action snapshot.
      if (revision === startedAt) seed(session);
      return value!;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { subscribe: store.subscribe, seed, seedFromServer, current, load };
}
