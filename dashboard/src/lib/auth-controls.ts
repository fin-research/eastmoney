import { protectedReport } from './protected-report.ts';
import { clientRequestPermission } from './route-permissions.ts';
import { requireClientPermission, sessionAllows, requestLogin } from './auth-client.ts';
import type { ClientSession } from './client-session';

/** Capture native submits and non-SPA links before the browser can unload the document. */
export function installAuthControls(state: ClientSession, document: Document, reportError: (message: string) => void, navigate?: (url: string) => Promise<unknown>) {
  const replay = new WeakSet<Element>();
  const pending = new WeakSet<Element>();
  function preflight(event: Event, element: Element, url: URL, method: string, resume: () => void) {
    if (url.origin !== document.location.origin || replay.has(element)) return;
    const permission = clientRequestPermission(url, method);
    if (!permission || permission === 'public') return;
    const current = state.current();
    if (current && sessionAllows(current, permission)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pending.has(element)) return;
    pending.add(element);
    void requireClientPermission(permission, document.location.pathname, state).then(allowed => {
      if (!allowed || !element.isConnected) return;
      replay.add(element);
      try { resume(); } finally { replay.delete(element); }
    }).catch(error => reportError(error.message)).finally(() => pending.delete(element));
  }
  function submit(event: SubmitEvent) {
    if (!(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    const button = event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement ? event.submitter : null;
    const action = button?.hasAttribute('formaction') ? button.formAction : form.action;
    const method = button?.hasAttribute('formmethod') ? button.formMethod : form.method;
    if (method.toLowerCase() === 'dialog') return;
    if (form.getAttribute('method')?.toLowerCase() === 'get' && method.toLowerCase() === 'get' && navigate && new URL(action).origin === document.location.origin) {
      event.preventDefault(); event.stopImmediatePropagation();
      const url = new URL(action);
      url.search = new URLSearchParams([...new FormData(form).entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString();
      void navigate(url.pathname + url.search).catch(error => reportError(error.message));
      return;
    }
    preflight(event, form, new URL(action, document.location.href), method, () => form.requestSubmit(button));
  }
  function click(event: MouseEvent) {
    const auxiliary = event.type === 'auxclick' && event.button === 1;
    if ((!auxiliary && event.button !== 0) || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const url = new URL(anchor.href, document.location.href);
    if (auxiliary && !anchor.hasAttribute('download') && !/\.html$/.test(url.pathname) && !url.pathname.startsWith('/api/')) return;
    if (url.origin === document.location.origin && url.pathname === '/auth/login') {
      event.preventDefault(); event.stopImmediatePropagation();
      void requestLogin(document.location.pathname);
      return;
    }
    // Normal same-tab SvelteKit links use beforeNavigate and resume via goto.
    if (!anchor.target && !anchor.hasAttribute('download') && !anchor.hasAttribute('data-sveltekit-reload')
      && !/\.html$/.test(url.pathname) && !url.pathname.startsWith('/api/') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) return;
    const permission = clientRequestPermission(url, 'GET');
    if (!permission || permission === 'public' || url.origin !== document.location.origin) return;
    // Protected documents and downloads use fetch; native navigations cannot attach Bearer.
    event.preventDefault(); event.stopImmediatePropagation();
    void requireClientPermission(permission, document.location.pathname, state).then(async allowed => {
      if (!allowed) return;
      if (!anchor.hasAttribute('download') && !/\.html$/.test(url.pathname) && !url.pathname.startsWith('/api/')) {
        if (navigate) await navigate(url.pathname + url.search + url.hash);
        return;
      }
      const response = await fetch(url);
      if (!response.ok) throw new Error('文件读取失败');
      if (/^text\/html/i.test(response.headers.get('Content-Type') ?? '')) {
        protectedReport.set(await response.text());
        return;
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = anchor.download || response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)/)?.[1] || url.pathname.split('/').pop() || 'download';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    }).catch(error => reportError(error.message));
  }
  function protectPreload(event: Event) {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || anchor.origin !== document.location.origin) return;
    const permission = clientRequestPermission(new URL(anchor.href), 'GET');
    const current = state.current();
    if (permission && permission !== 'public' && (!current || !sessionAllows(current, permission))) {
      if (!anchor.hasAttribute('data-auth-preload')) {
        anchor.dataset.authPreload = anchor.getAttribute('data-sveltekit-preload-data') ?? '';
        anchor.setAttribute('data-sveltekit-preload-data', 'off');
      }
    } else if (anchor.hasAttribute('data-auth-preload')) {
      const previous = anchor.dataset.authPreload;
      if (previous) anchor.setAttribute('data-sveltekit-preload-data', previous);
      else anchor.removeAttribute('data-sveltekit-preload-data');
      delete anchor.dataset.authPreload;
    }
  }
  function visibility() {
    const current=state.current();
    for(const element of document.querySelectorAll<HTMLElement>('a[href],form,[data-permission]')) {
      if(element.matches('a[href^="/auth/"]') || element.closest('[role="dialog"]')?.querySelector('input[autocomplete="username"]'))continue;
      let permission=element.dataset.permission;
      if(!permission && element.tagName === 'A' && new URL((element as HTMLAnchorElement).href).origin===document.location.origin)
        permission=clientRequestPermission(new URL((element as HTMLAnchorElement).href),'GET');
      if(!permission && element instanceof HTMLFormElement && new URL(element.action).origin===document.location.origin)
        permission=clientRequestPermission(new URL(element.action),element.method);
      if(!permission || permission==='public')continue;
      const denied=!current || !sessionAllows(current,permission);
      if(denied){element.setAttribute('data-auth-hidden','');element.setAttribute('inert','');}
      else if(element.hasAttribute('data-auth-hidden')){element.removeAttribute('data-auth-hidden');element.removeAttribute('inert');}
    }
  }
  const observer=new document.defaultView!.MutationObserver(visibility);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['href','action','data-permission']});
  const unsubscribe=state.subscribe(visibility);
  // Prevent speculative hover/tap preloads from opening login before a click.
  for (const type of ['mousemove', 'mousedown', 'touchstart']) document.addEventListener(type, protectPreload, true);
  document.addEventListener('submit', submit, true);
  document.addEventListener('click', click, true);
  document.addEventListener('auxclick', click, true);
  return () => {
    observer.disconnect(); unsubscribe();
    document.removeEventListener('submit', submit, true); document.removeEventListener('click', click, true); document.removeEventListener('auxclick', click, true);
    for (const type of ['mousemove', 'mousedown', 'touchstart']) document.removeEventListener(type, protectPreload, true);
  };
}
