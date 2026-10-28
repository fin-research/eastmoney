import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../../src/lib/financing/postgres.js';

test('shared permission queries retain the authorization schema boundary', async () => {
	const database = createPostgresDatabase('postgres://test:test@localhost/unused');
	let executedSql = '';
	database.client = {
		connect: async () => {},
		query: async (sql) => {
			executedSql = sql;
			return { rows: [], rowCount: 0 };
		},
		end: async () => {}
	};

	try {
		await database.prepare(`
			SELECT permission_code AS permissionCode
			FROM "authorization".role_permission
			WHERE auth0_role_id = ?
		`).all('rol_Admin');
		assert.match(executedSql, /FROM "authorization"\.role_permission/);
	} finally {
		await database.close();
	}
});
