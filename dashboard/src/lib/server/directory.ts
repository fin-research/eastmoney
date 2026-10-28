import { getRequestEvent } from '$app/server';
import { createDirectory } from './auth0-directory.ts';

export function getDirectory() {
  const event = getRequestEvent();
  if (!event.platform?.env) throw new Error('Auth0 服务未配置');
  return event.locals.directory ??= createDirectory(event.platform.env);
}
export async function activePerson(id: string) {
  return (await getDirectory().people()).some((person) => person.id === id && person.active);
}
