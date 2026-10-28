/// <reference path="../worker-configuration.d.ts" />

declare global {
  namespace App {
    interface Locals {
      user: import('$lib/identity').SiteIdentity | null;
      database: import('$lib/server/financing/db.js').PostgresDatabase | null;
      permissions: string[];
      directory?: import('$lib/server/auth0-directory').Auth0Directory;
    }
    interface Platform {
      env: Env;
      context: ExecutionContext;
      caches: CacheStorage & { default: Cache };
    }
  }
}

export {};
