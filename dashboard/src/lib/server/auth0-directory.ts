import { identityJson } from './gateway-client.ts';
export type Auth0Role = { id: string; name: string; description: string };
export type DirectoryPerson = { id: string; name: string; department: string; email: string; active: boolean; roles: Auth0Role[] };
export function createDirectory(config: Pick<Env, 'IDENTITY'>) {
  let roles: Promise<Auth0Role[]> | undefined;
  let people: Promise<DirectoryPerson[]> | undefined;
  return {
    roles: () => roles ??= identityJson<Auth0Role[]>(config, '/directory/roles'),
    people: () => people ??= identityJson<DirectoryPerson[]>(config, '/directory/people'),
  };
}
export type Auth0Directory = ReturnType<typeof createDirectory>;
