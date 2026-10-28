import { getContext } from 'svelte';
import type { ClientSessionData } from './identity';
import { derived, readable, type Readable } from 'svelte/store';
import { CLIENT_SESSION_CONTEXT, type ClientSession } from './client-session';
import { sessionAllows } from './auth-client';
import { clientRequestPermission } from './route-permissions';
export function permissionVisibility() {
 const state=getContext<ClientSession|undefined>(CLIENT_SESSION_CONTEXT);
 const source:Readable<ClientSessionData|null>=state ?? readable<ClientSessionData|null>(null);
 return derived<Readable<ClientSessionData|null>, (permission?:string,href?:string)=>boolean>(source, (session): ((permission?:string,href?:string)=>boolean) => (permission,href) => {
  if(!permission && href?.startsWith('/auth/'))return true;
  const needed=permission ?? (href?.startsWith('/') ? clientRequestPermission(new URL(href,'https://eastmoney.hasbai.xyz'),'GET') : undefined);
  if(needed?.includes('|'))return needed.split('|').some(code=>!!session&&sessionAllows(session,code));
  if(needed?.includes('&'))return needed.split('&').every(code=>!!session&&sessionAllows(session,code));
  return !needed || needed==='public' || !!session && sessionAllows(session,needed);
 });
}
