import { Client } from 'pg';
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { buildAuth0Import } from './lib/auth0-migration.mjs';

const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
const database = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await database.connect();
  await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await database.query(`
    SELECT u.id::text, u.name, u.email, u."emailVerified" AS email_verified,
      COALESCE(u.banned, FALSE) banned, a.password, p.id AS person_id, p.role, p.active
    FROM neon_auth."user" u
    LEFT JOIN neon_auth.account a ON a."userId" = u.id AND a."providerId" = 'credential'
    LEFT JOIN financing.people p ON p.neon_auth_user_id = u.id
    ORDER BY u.id
  `);
  const users = buildAuth0Import(rows);
  if (output) {
    const file = resolve(output);
    const repo = resolve(new URL('../..', import.meta.url).pathname);
    if (!relative(repo, file).startsWith('..')) throw new Error('Password hash exports must stay outside the repository');
    await writeFile(file, JSON.stringify(users), { mode: 0o600, flag: 'wx' });
  }
  await database.query('COMMIT');
  console.log(JSON.stringify({ users: users.length, linkedPeople: users.filter((user) => user.app_metadata.financing_person_id).length,
    passwordFormat: 'scrypt N=16384 r=16 p=1 keylen=64 salt=utf8', written: Boolean(output),
    roles: Object.fromEntries(['admin', 'handler', 'reviewer'].map((role) => [role, users.filter((user) => user.app_metadata.neon_role === role).length])),
    verifiedEmails: users.filter((user) => user.email_verified).length }));
} finally { await database.end(); }
