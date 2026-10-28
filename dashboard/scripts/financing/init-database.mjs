import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('缺少 DATABASE_URL；数据库初始化必须从本地直连 Neon');

const client = new Client({ connectionString, application_name: 'eastmoney-financing-init' });
const migrationDirectory = path.resolve('financing-migrations');
const migrations = fs.readdirSync(migrationDirectory)
	.filter((name) => /^\d+.*\.sql$/.test(name))
	.sort();

function migrationBody(sql) {
	return sql
		.replace(/^\s*BEGIN\s*;?/i, '')
		.replace(/\s*COMMIT\s*;?\s*$/i, '');
}

await client.connect();
try {
	await client.query('CREATE SCHEMA IF NOT EXISTS financing');
	await client.query(`
		CREATE TABLE IF NOT EXISTS financing.schema_migrations (
			name text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);
	const applied = new Set((await client.query('SELECT name FROM financing.schema_migrations')).rows.map((row) => row.name));
	for (const name of migrations) {
		if (applied.has(name)) continue;
		await client.query('BEGIN');
		try {
			await client.query(migrationBody(fs.readFileSync(path.join(migrationDirectory, name), 'utf8')));
			await client.query('INSERT INTO financing.schema_migrations (name) VALUES ($1)', [name]);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		}
	}

	console.log(JSON.stringify({ database: 'neon', schema: 'financing', migrations, status: 'initialized' }, null, 2));
} finally {
	await client.end();
}
