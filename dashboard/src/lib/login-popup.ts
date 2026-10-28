import type { ClientSession } from './client-session';
import { loginFailure, loginFailureFromCode, type LoginFailure } from './login-failure.ts';


/** SDK owns PKCE, state, popup origin checks and the in-memory token cache. */
export function createLoginPopup(state: ClientSession, options: {
  complete: () => void; error: (failure: LoginFailure) => void; waiting: (value: boolean) => void;
}, host: Window = window, authenticate: (popup: Window) => Promise<import('./identity.ts').ClientSessionData> = async popup => {
  const { loginPopup } = await import('./bearer-auth.ts');
  return loginPopup(popup);
}) {
  let revision = 0;
  let popup: Window | null = null;
  function stop() { revision++; popup?.close(); popup = null; options.waiting(false); }
  async function open() {
    stop();
    const attempt = revision;
    // Open synchronously from the user gesture before the SDK awaits anything.
    popup = host.open('', 'eastmoney-login', 'popup,width=480,height=720');
    if (!popup) { options.error(loginFailureFromCode('popup_blocked')); return; }
    options.waiting(true);
    try {
      const session = await authenticate(popup);
      if (attempt !== revision) return;
      if (!session.user) throw new Error('登录未完成，请重试');
      state.seed(session);
      stop(); options.complete();
    } catch (error) {
      if (attempt === revision) { stop(); options.error(loginFailure(error)); }
    }
  }
  return { open, stop };
}
