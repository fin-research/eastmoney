// @ts-nocheck
import { getRequestEvent } from '$app/server';
import { createPostgresDatabase } from '../../financing/postgres.js';

export { PostgresDatabase, createPostgresDatabase } from '../../financing/postgres.js';

export function getDatabase(event = getRequestEvent()) {
	if (event.locals.database) return event.locals.database;
	const connectionString = event.platform?.env?.HYPERDRIVE?.connectionString;
	if (!connectionString) {
		throw new Error('Hyperdrive binding HYPERDRIVE is unavailable. Run through Wrangler or deploy to Cloudflare.');
	}
	event.locals.database = createPostgresDatabase(connectionString);
	return event.locals.database;
}

export async function closeDatabase(event) {
	const database = event.locals.database;
	event.locals.database = null;
	await database?.close();
}
