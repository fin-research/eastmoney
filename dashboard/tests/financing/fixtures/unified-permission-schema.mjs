import {readFile, readdir} from 'node:fs/promises';
const root=new URL('../../../',import.meta.url);
export async function legacyPermissionSchema(db) {
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anonymous;
    CREATE TABLE public.edb (indicator_code text NOT NULL, observation_date date NOT NULL, value numeric, PRIMARY KEY(indicator_code,observation_date));
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.sub', true) $$;
    CREATE SCHEMA neon_auth;
    CREATE TABLE neon_auth."user" (id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, role text, banned boolean);
    CREATE TABLE neon_auth.session (id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES neon_auth."user"(id),"createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  for(const name of (await readdir(new URL('financing-migrations/',root))).filter(name=>name.endsWith('.sql')&&name<'0032').sort()) await db.exec(await readFile(new URL('financing-migrations/'+name,root),'utf8'));
}
export async function migratePermissions(db, {users=[{user_id:'auth0|person'}],mapping={},roles=[{id:'rol_Admin',name:'financing:admin'},{id:'rol_Handler',name:'financing:handler'},{id:'rol_Reviewer',name:'financing:reviewer'}]}={}) {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('migration.auth0_users',$1,true),set_config('migration.person_mapping',$2,true),set_config('migration.auth0_roles',$3,true)",[JSON.stringify(users),JSON.stringify(mapping),JSON.stringify(roles)]);
    await db.exec(await readFile(new URL('authorization-migrations/0001_permissions.sql',root),'utf8'));
    const sql=(await readFile(new URL('financing-migrations/0032_unified_permissions.sql',root),'utf8')).replace(/^\s*BEGIN\s*;/i,'').replace(/COMMIT;\s*$/i,'');
    await db.exec(sql);await db.exec('COMMIT');
  }catch(error){await db.exec('ROLLBACK');throw error;}
}
