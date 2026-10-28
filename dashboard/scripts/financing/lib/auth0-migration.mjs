/** Convert Better Auth's scrypt representation without reading or resetting a password. */
export function auth0ImportUser(row) {
  const email = String(row.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@18\.cn$/.test(email)) throw new Error('Existing account has an unsupported email domain');
  if (!/^[0-9a-f-]{36}$/.test(row.id)) throw new Error('Existing account ID is invalid');
  const parts = /^([0-9a-f]{32}):([0-9a-f]{128})$/.exec(row.password ?? '');
  if (!parts) throw new Error('Unsupported legacy password format; stop without changing passwords');
  if (row.person_id && !['admin', 'handler', 'reviewer'].includes(row.role)) throw new Error('Unsupported financing role');
  return {
    user_id: row.id, email, name: row.name,
    email_verified: Boolean(row.email_verified), blocked: Boolean(row.banned),
    app_metadata: {
      migrated_from: 'neon', neon_auth_user_id: row.id, neon_email: email,
      financing_person_id: row.person_id ?? null, neon_role: row.role ?? null,
      financing_enabled: Boolean(row.person_id && row.active), roles_initialized: true,
    },
    custom_password_hash: {
      algorithm: 'scrypt', hash: { value: parts[2], encoding: 'hex' },
      // Better Auth passes the hexadecimal-looking salt as UTF-8 TEXT to scrypt.
      salt: { value: parts[1], encoding: 'utf8' },
      cost: 16384, blockSize: 16, parallelization: 1, keylen: 64,
    },
  };
}

export function buildAuth0Import(rows) {
  const users = rows.map(auth0ImportUser);
  if (new Set(users.map((user) => user.email)).size !== users.length) throw new Error('Duplicate email in legacy identities');
  if (new Set(users.map((user) => user.user_id)).size !== users.length) throw new Error('Duplicate legacy identity');
  return users;
}
