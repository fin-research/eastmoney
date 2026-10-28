// @ts-nocheck
import { Client, types } from 'pg';
import { financingTimestamp } from './time.js';

// Keep financing's string dates local to its client. Mutating pg's global parsers
// would also change bond/credit/model queries in the merged Worker.
const financingTypes = {
	getTypeParser(oid, format) {
		if (format !== 'binary' && oid === 1082) return (value) => value;
		if (format !== 'binary' && [1114, 1184].includes(oid)) return financingTimestamp;
		return types.getTypeParser(oid, format);
	}
};

const FINANCING_TABLES = [
	'sop_templates', 'sop_nodes', 'projects',
	'project_tasks', 'debt', 'bond', 'income_certificate', 'income_right', 'refinancing',
	'swap_facility', 'cashflow', 'balance_snapshot', 'reminder_rules', 'reminder_rule_nodes',
	'reminder_rule_periods', 'reminder_deliveries',
	'finance_parameters', 'financial_monthly_data', 'debt_limit_configs',
	'liability_weekly_report_runs', 'debt_overview',
	'cashflow_overview', 'data_overview',
	'monthly_financing_metrics'
];

function normaliseValue(value) {
	return value === undefined ? null : value;
}

function qualifyTables(sql) {
	let result = sql;
	for (const table of FINANCING_TABLES) {
		const expression = new RegExp(`\\b(DELETE\\s+FROM|FROM|JOIN|UPDATE|INTO)\\s+(${table})\\b`, 'gi');
		result = result.replace(expression, (_match, keyword, name) => `${keyword} financing.${name}`);
	}
	return result;
}

function compileParameters(sql, args) {
	let values;
	let compiled = sql;
	if (args.length === 1 && Array.isArray(args[0])) {
		values = args[0].map(normaliseValue);
	} else if (args.length === 1 && args[0] && typeof args[0] === 'object') {
		values = [];
		compiled = compiled.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (placeholder, name) => {
			if (!(name in args[0])) return placeholder;
			values.push(normaliseValue(args[0][name]));
			return '?';
		});
	} else {
		values = args.map(normaliseValue);
	}

	let parameterIndex = 0;
	compiled = compiled.replace(/\?/g, () => `$${++parameterIndex}`);
	if (parameterIndex !== values.length) {
		throw new Error(`SQL 参数数量不一致：语句需要 ${parameterIndex} 个，实际收到 ${values.length} 个`);
	}
	return { sql: qualifyTables(compiled), values };
}

function aliasMap(sql) {
	return new Map(
		[...sql.matchAll(/\bAS\s+([A-Za-z][A-Za-z0-9_]*)/gi)]
			.map((match) => [match[1].toLowerCase(), match[1]])
	);
}

function restoreAliases(rows, sql) {
	const aliases = aliasMap(sql);
	if (!aliases.size) return rows;
	return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [aliases.get(key) ?? key, value])));
}

class BoundStatement {
	constructor(database, sql, values) {
		this.database = database;
		this.sql = sql;
		this.values = values;
	}

	async all() {
		const result = await this.database.query(this.sql, this.values);
		return restoreAliases(result.rows, this.sql);
	}

	async get() {
		return (await this.all())[0];
	}

	async run() {
		const result = await this.database.query(this.sql, this.values);
		return { meta: { changes: result.rowCount ?? 0, rows_written: result.rowCount ?? 0 } };
	}
}

function preparedStatement(database, sql) {
	const bind = (args) => {
		const compiled = compileParameters(sql, args);
		return new BoundStatement(database, compiled.sql, compiled.values);
	};
	return {
		all(...args) { return bind(args).all(); },
		get(...args) { return bind(args).get(); },
		run(...args) { return bind(args).run(); },
		bind(...args) { return bind(args); }
	};
}

export class PostgresDatabase {
	constructor(connectionString, applicationName = 'eastmoney-financing') {
		if (!connectionString) throw new Error('PostgreSQL connection string is unavailable');
		this.client = new Client({ connectionString, application_name: applicationName, keepAlive: true, types: financingTypes });
		this.connecting = null;
		this.closed = false;
		this.queryCount = 0;
		this.queryDurationMs = 0;
	}

	async connect() {
		if (this.closed) throw new Error('PostgreSQL request connection is already closed');
		this.connecting ??= this.client.connect();
		await this.connecting;
	}

	/** @param {string} sql @param {unknown[]} [values] @returns {Promise<import('pg').QueryResult<Record<string, any>>>} */
	async query(sql, values = []) {
		const startedAt = performance.now();
		this.queryCount += 1;
		try {
			await this.connect();
			return await this.client.query(sql, values);
		} finally {
			this.queryDurationMs += performance.now() - startedAt;
		}
	}

	prepare(sql) { return preparedStatement(this, sql); }

	async batch(statements) {
		await this.query('BEGIN');
		try {
			const results = [];
			for (const statement of statements) {
				if (!(statement instanceof BoundStatement) || statement.database !== this) {
					throw new Error('batch 仅接受当前数据库创建的已绑定语句');
				}
				results.push(await statement.run());
			}
			await this.query('COMMIT');
			return results;
		} catch (error) {
			await this.query('ROLLBACK');
			throw error;
		}
	}

	async transaction(callback) {
		await this.query('BEGIN');
		try {
			const result = await callback(this);
			await this.query('COMMIT');
			return result;
		} catch (error) {
			await this.query('ROLLBACK');
			throw error;
		}
	}

	exec(sql) { return this.query(sql); }

	async close() {
		if (this.closed) return;
		this.closed = true;
		if (!this.connecting) return;
		try {
			await this.connecting;
		} finally {
			await this.client.end();
		}
	}
}

export function createPostgresDatabase(connectionString, applicationName) {
	return new PostgresDatabase(connectionString, applicationName);
}
