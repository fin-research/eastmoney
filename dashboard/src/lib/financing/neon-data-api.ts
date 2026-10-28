import { withBase } from './app-paths';
import type { DataRow, EntityConfig } from './data-admin';
import { LIABILITY_REPORT_EDB_CODES } from './liability-report-data.js';

export type ListOptions = {
	page: number;
	pageSize: number;
	sortKey: string;
	sortDirection: 'asc' | 'desc';
	search: string;
	lifecycle?: string;
	asOfDate?: string;
	status?: string;
	subtype?: string;
	issueFrom?: string;
	issueTo?: string;
	filters?: Record<string, {value?: string; min?: string; max?: string}>;
};

type ApiErrorBody = { message?: string; details?: string; hint?: string; code?: string };

export class NeonDataApi {
	#session: { token?: string; dataApiUrl: string } | null = null;
	#sessionRequest: Promise<{ token?: string; dataApiUrl: string }> | null = null;

	async #getSession(force = false) {
		if (this.#session && !force) return this.#session;
		if (force) {
			this.#session = null;
			this.#sessionRequest = null;
		}
		if (this.#sessionRequest) return this.#sessionRequest;
		const request = (async () => {
			const response = await fetch(withBase('/data/token'), { headers: { Accept: 'application/json' }, cache: 'no-store' });
			if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录' : '无法取得数据后台访问令牌');
			const body = await response.json() as { token?: string; dataApiUrl?: string; transport?: string };
			if (!body.token && body.transport !== 'worker') throw new Error('Neon Data API 令牌为空');
			if (!body.dataApiUrl) throw new Error('Neon Data API 地址为空');
			const parsed = new URL(body.dataApiUrl);
			if (body.transport === 'worker' && (parsed.origin !== window.location.origin || parsed.pathname !== withBase('/data/api'))) throw new Error('数据后台代理地址无效');
			if (parsed.protocol !== 'https:') throw new Error('Neon Data API 必须使用 HTTPS');
			return {
				token: body.token,
				dataApiUrl: parsed.toString().replace(/\/$/, '')
			};
		})();
		this.#sessionRequest = request;
		try {
			this.#session = await request;
			return this.#session;
		} finally {
			if (this.#sessionRequest === request) this.#sessionRequest = null;
		}
	}

	async #request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
		const session = await this.#getSession();
		const headers = new Headers(init.headers);
		if (session.token) headers.set('Authorization', `Bearer ${session.token}`);
		headers.set('Accept', 'application/json');
		headers.set('Accept-Profile', 'financing');
		headers.set('Content-Profile', 'financing');
		if (init.body !== undefined) headers.set('Content-Type', 'application/json');
		const response = await fetch(`${session.dataApiUrl}/${path}`, { ...init, headers });
		if (response.status === 401 && retry) {
			await this.#getSession(true);
			return this.#request(path, init, false);
		}
		if (!response.ok) {
			const body = await response.json().catch(() => ({})) as ApiErrorBody;
			const details = [body.message, body.details, body.hint].filter(Boolean).join('；');
			throw new Error(details || `Neon Data API 请求失败（${response.status}）`);
		}
		return response;
	}

	async list(config: EntityConfig, options: ListOptions) {
		const selected = config.fields.map((field) => field.key).join(',');
		const params = new URLSearchParams({
			select: selected,
			order: [ `${options.sortKey}.${options.sortDirection}.nullslast`, ...config.primaryKeys.filter(key => key !== options.sortKey).map(key => `${key}.desc.nullslast`) ].join(','),
			limit: String(options.pageSize),
			offset: String(options.page * options.pageSize)
		});
		for (const [key, value] of Object.entries(config.fixedValues ?? {})) {
			params.set(key, value === null ? 'is.null' : `eq.${String(value)}`);
		}
		for (const [key, filter] of Object.entries(options.filters ?? {})) params.set(`filter_${key}`, JSON.stringify(filter));
		if (options.lifecycle === 'unmatured') {
			params.set('lifecycle', 'unmatured');
			params.set('as_of', options.asOfDate ?? '');
		}
		if (options.status) params.set('status', `eq.${options.status}`);
		if (options.subtype && !Object.hasOwn(config.fixedValues ?? {}, 'subtype') && config.fields.some(field => field.key === 'subtype' && field.options?.some(choice => choice.value === options.subtype))) params.set('subtype', `eq.${options.subtype}`);
		if (options.issueFrom) params.set('issue_from', options.issueFrom);
		if (options.issueTo) params.set('issue_to', options.issueTo);
		const search = options.search.trim().replace(/[,*()]/g, ' ');
		if (search && config.searchFields.length) {
			params.set('or', `(${config.searchFields.map((field) => `${field}.ilike.*${search}*`).join(',')})`);
		}
		const response = await this.#request(`${config.tableName}?${params}`, { headers: { Prefer: 'count=exact' } });
		const rows = await response.json() as DataRow[];
		const totalPart = response.headers.get('content-range')?.split('/')[1];
		return { rows, total: totalPart && totalPart !== '*' ? Number(totalPart) : rows.length };
	}

	async all(config: EntityConfig, options: ListOptions) {
		const rows: DataRow[] = [];
		const seen = new Set<string>();
		let expectedTotal: number | null = null;
		for (let page = 0; ; page++) {
			const result = await this.list(config, { ...options, page, pageSize: 500 });
			if (expectedTotal === null) expectedTotal = result.total;
			if (result.total !== expectedTotal) throw new Error('导出数据已变化，请重试');
			for (const row of result.rows) {
				const id = config.primaryKeys.map(key => String(row[key])).join(':');
				if (seen.has(id)) throw new Error('导出数据已变化，请重试');
				seen.add(id);
				rows.push(row);
			}
			if (rows.length === expectedTotal) return rows;
			if (!result.rows.length || rows.length > expectedTotal) throw new Error('导出数据已变化，请重试');
		}
	}

	async get(config: EntityConfig, id: string) {
		const params = this.#rowFilter(config, { id }, false);
		params.set('limit', '1');
		const response = await this.#request(`${config.tableName}?${params}`);
		const rows = await response.json() as DataRow[];
		if (!rows[0]) throw new Error('记录不存在或已删除');
		return rows[0];
	}

	#rowFilter(config: EntityConfig, row: DataRow, includeVersion = true) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(config.fixedValues ?? {})) params.set(key, value === null ? 'is.null' : `eq.${String(value)}`);
		for (const key of config.primaryKeys) params.set(key, `eq.${String(row[key])}`);
		if (includeVersion && row.updated_at) params.set('updated_at', `eq.${String(row.updated_at)}`);
		return params;
	}

	async insert(config: EntityConfig, row: DataRow) {
		const response = await this.#request(config.tableName, {
			method: 'POST',
			headers: { Prefer: 'return=representation' },
			body: JSON.stringify({ ...config.fixedValues, ...row })
		});
		return await response.json() as DataRow[];
	}

	async update(config: EntityConfig, original: DataRow, changes: DataRow) {
		const params = this.#rowFilter(config, original);
		const response = await this.#request(`${config.tableName}?${params}`, {
			method: 'PATCH',
			headers: { Prefer: 'return=representation' },
			body: JSON.stringify(changes)
		});
		const rows = await response.json() as DataRow[];
		if (!rows.length) throw new Error('记录已被其他人修改，请刷新后重试');
		return rows;
	}

	async delete(config: EntityConfig, row: DataRow) {
		const params = this.#rowFilter(config, row);
		const response = await this.#request(`${config.tableName}?${params}`, {
			method: 'DELETE',
			headers: { Prefer: 'return=representation' }
		});
		const rows = await response.json() as DataRow[];
		if (!rows.length) throw new Error('记录已被其他人修改或已经删除');
	}

	async liabilityWeeklyReportBusiness(reportDate: string) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('负债周报日期无效');
		const response = await this.#request('rpc/liability_weekly_report_data', {
			method: 'POST',
			body: JSON.stringify({ p_report_date: reportDate })
		});
		return await response.json() as Record<string, unknown>;
	}

	async liabilityMarketRates(reportDate: string) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('负债周报日期无效');
		const params = new URLSearchParams({
			select: 'indicator_code,observation_date,value',
			indicator_code: `in.(${LIABILITY_REPORT_EDB_CODES.join(',')})`,
			order: 'indicator_code.asc,observation_date.asc',
			limit: '5000'
		});
		params.append('observation_date', `gte.${reportDate.slice(0, 4)}-01-01`);
		params.append('observation_date', `lte.${reportDate}`);
		const response = await this.#request(`liability_market_rate_observations?${params}`);
		return await response.json() as Array<{ indicator_code: string; observation_date: string; value: number | null }>;
	}
}
