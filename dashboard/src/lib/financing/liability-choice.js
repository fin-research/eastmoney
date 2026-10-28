// @ts-nocheck

export const CTR_REPORT = 'BondIssueDetail';
export const CTR_INDICATOR_LIST = [
	'SECUCODE', 'BOND_NAME_ABBR', 'BOND_TYPE', 'ISSUE_DATE',
	'ACTUAL_ISSUE_SCALE', 'BOND_EXPIRE_YEAR', 'ISSUERATE_REFERENCE',
	'PAYPERYEAR', 'TOMRTY_YEAR', 'DEC_TOMRTYYEAR1', 'ISSUER_RATING',
	'BOND_RATING', 'IS_OEB', 'IS_GUARANTEE', 'PI_RATE_TYPE',
	'ISSUER_NAME', 'ORGFORM'
];
export const CTR_INDICATORS = CTR_INDICATOR_LIST.join(',');
export const REGISTRATION_FIELDS = [
	'projectName', 'issuerName', 'status', 'variety', 'amountYi', 'region', 'industry',
	'leadUnderwriter', 'noticeNumber', 'venue', 'registrationOrFiling', 'updateDate'
];

// Keep this identical to quant/data/choice_bond_data.py. The CTR report
// silently returns no rows when its report-specific filters are omitted.
function ctrOptions(startDate, endDate) {
	return [
		`StartDate=${startDate}`,
		`EndDate=${endDate}`,
		'Bond_Type=646003',
		'Frequency=1',
		'Issuer_Rating=-',
		'Bond_Rating=-',
		'Issue_Date_Type=2',
		'Tenor=-',
		'Company_Type=-'
	].join(',');
}

function dateShift(date, days) {
	const value = new Date(`${date}T00:00:00Z`);
	value.setUTCDate(value.getUTCDate() + days);
	return value.toISOString().slice(0, 10);
}

function reportWeek(asOfDate) {
	const value = new Date(`${asOfDate}T00:00:00Z`);
	const daysSinceMonday = (value.getUTCDay() + 6) % 7;
	return { startDate: dateShift(asOfDate, -daysSinceMonday), endDate: asOfDate };
}

function choiceUrl(base, pathname, params) {
	const url = new URL(`${base.replace(/\/$/, '')}/${pathname.replace(/^\/+/, '')}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url;
}

function wait(milliseconds) {
	return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function isPrimitive(value) {
	return value == null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function buildManualLiabilityRequests(asOfDate) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate ?? ''))) throw new Error('负债周报数据日期无效');
	const startDate = `${asOfDate.slice(0, 4)}-01-01`;
	const weekWindow = reportWeek(asOfDate);
	return {
		issuanceWindow: { startDate, endDate: asOfDate },
		weekWindow,
		ctrRequest: {
			reportName: CTR_REPORT,
			indicators: CTR_INDICATORS,
			options: ctrOptions(startDate, asOfDate)
		},
		registrationRequest: { pageSize: 50, fields: REGISTRATION_FIELDS.join(',') }
	};
}

async function fetchChoiceTable(base, pathname, params, fetchImpl = fetch, {
	maxAttempts = 3,
	retryDelayMs = 250
} = {}) {
	const url = choiceUrl(base, pathname, params);
	const attempts = Math.max(1, Number(maxAttempts) || 1);
	const delayMs = Math.max(0, Number(retryDelayMs) || 0);
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
			if (!response.ok) throw new Error(`Choice ${pathname} 请求失败（HTTP ${response.status}）`);
			const table = await response.json();
			if (!table || !Array.isArray(table.rows) || !Array.isArray(table.fields)) {
				throw new Error(`Choice ${pathname} 返回结构无效`);
			}
			return table;
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await wait(delayMs * (2 ** (attempt - 1)));
		}
	}
	throw lastError;
}

async function fetchRegistrationPage(base, params, fetchImpl = fetch, {
	maxAttempts = 3,
	retryDelayMs = 250
} = {}) {
	const url = choiceUrl(base, '/broker-bond-registrations', params);
	const attempts = Math.max(1, Number(maxAttempts) || 1);
	const delayMs = Math.max(0, Number(retryDelayMs) || 0);
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
			if (!response.ok) throw new Error(`DM 券商债券申报请求失败（HTTP ${response.status}）`);
			const page = await response.json();
			if (!page || typeof page.hasNextPage !== 'boolean' || !Array.isArray(page.rows)) {
				throw new Error('DM 券商债券申报返回结构无效');
			}
			return page;
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await wait(delayMs * (2 ** (attempt - 1)));
		}
	}
	throw lastError;
}

async function fetchBrokerBondRegistrations(base, registrationWindow, registrationRequest, fetchImpl, options) {
	const rows = [];
	const maximumPages = 20;
	for (let pageNum = 1; pageNum <= maximumPages; pageNum += 1) {
		const page = await fetchRegistrationPage(base, {
			...registrationWindow,
			...registrationRequest,
			pageNum: String(pageNum),
			pageSize: String(registrationRequest.pageSize)
		}, fetchImpl, options);
		rows.push(...page.rows);
		if (!page.hasNextPage) return { rows, pageCount: pageNum };
	}
	throw new Error(`DM 券商债券申报超过 ${maximumPages} 页，未保存不完整结果`);
}

/**
 * Comparable issuance and registration data are queried only after the user
 * clicks the report button. This module is browser-safe so both requests go
 * straight to the public data Worker instead of nesting subrequests inside
 * financing.
 */
export async function fetchManualLiabilitySources({
	dataApiUrl,
	asOfDate,
	fetchImpl = fetch,
	maxAttempts = 3,
	retryDelayMs = 250
}) {
	if (!dataApiUrl) throw new Error('未配置统一数据 API 地址');
	const { issuanceWindow, weekWindow, ctrRequest, registrationRequest } = buildManualLiabilityRequests(asOfDate);
	const options = { maxAttempts, retryDelayMs };
	const [ctr, registration] = await Promise.all([Promise.resolve(fetchChoiceTable(
		dataApiUrl,
		'/choice/ctr',
		ctrRequest,
		fetchImpl,
		options
	)).then(
		(value) => ({ status: 'fulfilled', value }),
		(reason) => ({ status: 'rejected', reason })
	), Promise.resolve(fetchBrokerBondRegistrations(
		dataApiUrl,
		weekWindow,
		registrationRequest,
		fetchImpl,
		options
	)).then(
		(value) => ({ status: 'fulfilled', value }),
		(reason) => ({ status: 'rejected', reason })
	)]);
	return {
		issuanceWindow,
		weekWindow,
		ctr: ctr.status === 'fulfilled'
			? {
				status: 'available', path: '/choice/ctr',
				request: ctrRequest,
				function: ctr.value.function, fields: ctr.value.fields, rows: ctr.value.rows
			}
			: {
				status: 'missing', path: '/choice/ctr',
				request: ctrRequest,
				error: String(ctr.reason?.message ?? ctr.reason)
			},
		registration: registration.status === 'fulfilled'
			? {
				status: 'available', path: '/broker-bond-registrations',
				request: registrationRequest, fields: REGISTRATION_FIELDS,
				pageCount: registration.value.pageCount, rows: registration.value.rows
			}
			: {
				status: 'missing', path: '/broker-bond-registrations',
				request: registrationRequest,
				error: String(registration.reason?.message ?? registration.reason)
			}
	};
}

const PEER_BOND_TYPES = new Set(['证券公司债', '证券公司次级债', '证券公司短期融资券']);

function nullableNumber(value, field) {
	if (value === null || value === undefined || value === '' || value === '-') return null;
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) throw new Error(`Choice CTR 字段 ${field} 无效`);
	return number;
}

function ctrText(value, field, { required = false } = {}) {
	if (value === null || value === undefined || value === '') {
		if (required) throw new Error(`Choice CTR 字段 ${field} 无效`);
		return null;
	}
	const text = String(value).trim();
	if (!text || text.length > 500) throw new Error(`Choice CTR 字段 ${field} 无效`);
	return text;
}

function peerBondType(value, originalTermYears) {
	if (value === '证券公司债') return originalTermYears != null && originalTermYears <= 1 ? '短期公司债' : '公募债';
	if (value === '证券公司次级债') return '次级债';
	if (value === '证券公司短期融资券') return '短期融资券';
	return null;
}

function peerMarket(securityCode) {
	if (securityCode.endsWith('.IB')) return '银行间';
	if (securityCode.endsWith('.SH')) return '上交所';
	if (securityCode.endsWith('.SZ')) return '深交所';
	return null;
}

function normalizeCtr(value, ctrRequest, issuanceWindow, weekWindow) {
	if (!value || value.status !== 'available') {
		return {
			ctr: {
				status: 'missing', path: '/choice/ctr', request: ctrRequest,
				error: String(value?.error ?? '本次尚未手动拉取 Choice CTR。').slice(0, 500)
			},
			peerIssuances: [],
			peerIssueSummary: []
		};
	}
	if (String(value.function ?? '').toUpperCase() !== 'CTR') throw new Error('Choice CTR 返回函数类型无效');
	if (!Array.isArray(value.fields) || value.fields.join(',') !== CTR_INDICATORS) {
		throw new Error('Choice CTR 字段列表无效');
	}
	if (!Array.isArray(value.rows) || value.rows.length > 10_000) throw new Error('Choice CTR 数据行数无效');
	const rows = [];
	const unique = new Set();
	for (const row of value.rows) {
		if (!row || Array.isArray(row) || typeof row !== 'object') throw new Error('Choice CTR 数据行结构无效');
		const normalized = {};
		for (const field of CTR_INDICATOR_LIST) {
			if (!(field in row)) continue;
			if (!isPrimitive(row[field])) throw new Error(`Choice CTR 字段 ${field} 的值无效`);
			normalized[field] = row[field];
		}
		rows.push(normalized);
	}

	const yearRows = [];
	for (const row of rows) {
		const sourceBondType = ctrText(row.BOND_TYPE, 'BOND_TYPE');
		const issuerName = ctrText(row.ISSUER_NAME, 'ISSUER_NAME');
		const issueDate = ctrText(row.ISSUE_DATE, 'ISSUE_DATE');
		if (!PEER_BOND_TYPES.has(sourceBondType) || !issuerName?.includes('证券')) continue;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate ?? '') || issueDate < issuanceWindow.startDate || issueDate > issuanceWindow.endDate) continue;
		const securityCode = ctrText(row.SECUCODE, 'SECUCODE', { required: true });
		const bondName = ctrText(row.BOND_NAME_ABBR, 'BOND_NAME_ABBR', { required: true });
		const actualIssueAmountYi = nullableNumber(row.ACTUAL_ISSUE_SCALE, 'ACTUAL_ISSUE_SCALE');
		const originalTermYears = nullableNumber(row.BOND_EXPIRE_YEAR ?? row.TOMRTY_YEAR, 'BOND_EXPIRE_YEAR');
		const normalizedBondType = peerBondType(sourceBondType, originalTermYears);
		const key = `${securityCode}|${issueDate}`;
		if (unique.has(key)) continue;
		unique.add(key);
		yearRows.push({
			securityCode,
			bondName,
			issuerName,
			bondType: normalizedBondType,
			actualIssueAmountYi,
			issueTenor: ctrText(row.DEC_TOMRTYYEAR1, 'DEC_TOMRTYYEAR1') ?? (originalTermYears == null ? null : `${originalTermYears}年`),
			issueDate,
			maturityDate: null,
			market: peerMarket(securityCode),
			couponRatePct: nullableNumber(row.ISSUERATE_REFERENCE, 'ISSUERATE_REFERENCE')
		});
	}
	const issuerTotals = new Map();
	for (const row of yearRows) {
		issuerTotals.set(row.issuerName, (issuerTotals.get(row.issuerName) ?? 0) + Number(row.actualIssueAmountYi ?? 0));
	}
	const topIssuers = new Set([...issuerTotals.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
		.slice(0, 15)
		.map(([issuerName]) => issuerName));
	const summary = new Map();
	for (const row of yearRows) {
		if (!topIssuers.has(row.issuerName) || row.actualIssueAmountYi == null) continue;
		const key = `${row.issuerName}|${row.bondType}`;
		const current = summary.get(key) ?? { issuerName: row.issuerName, bondType: row.bondType, amountYi: 0 };
		current.amountYi += row.actualIssueAmountYi;
		summary.set(key, current);
	}
	return {
		ctr: {
			status: 'available', path: '/choice/ctr', request: ctrRequest,
			function: 'CTR', fields: CTR_INDICATOR_LIST, rows
		},
		peerIssuances: yearRows
			.filter((row) => row.issueDate >= weekWindow.startDate && row.issueDate <= weekWindow.endDate)
			.sort((left, right) => right.issueDate.localeCompare(left.issueDate) || left.bondName.localeCompare(right.bondName, 'zh-CN')),
		peerIssueSummary: [...summary.values()]
	};
}

function requiredText(value, field) {
	const text = String(value ?? '').trim();
	if (!text || text.length > 500) throw new Error(`DM 券商债券申报字段 ${field} 无效`);
	return text;
}

function optionalText(value, field) {
	if (value === null || value === undefined || value === '') return null;
	const text = String(value).trim();
	if (!text || text.length > 1_000) throw new Error(`DM 券商债券申报字段 ${field} 无效`);
	return text;
}

function registrationAmount(value) {
	if (value === null || value === undefined || value === '') return null;
	const result = Number(value);
	if (!Number.isFinite(result) || result < 0) throw new Error('DM 券商债券申报金额无效');
	return result;
}

function normalizeRegistration(value, weekWindow, registrationRequest) {
	if (!value || value.status !== 'available') {
		return {
			status: 'missing', path: '/broker-bond-registrations', request: registrationRequest,
			error: String(value?.error ?? '本次尚未手动拉取 DM 券商债券申报。').slice(0, 500)
		};
	}
	if (!Array.isArray(value.fields) || value.fields.join(',') !== REGISTRATION_FIELDS.join(',')) {
		throw new Error('DM 券商债券申报字段列表无效');
	}
	if (!Array.isArray(value.rows) || value.rows.length > 10_000) {
		throw new Error('DM 券商债券申报数据行数无效');
	}
	const unique = new Map();
	for (const row of value.rows) {
		if (!row || Array.isArray(row) || typeof row !== 'object') throw new Error('DM 券商债券申报数据行结构无效');
		const updateDate = requiredText(row.updateDate, 'updateDate');
		if (!/^\d{4}-\d{2}-\d{2}$/.test(updateDate) || updateDate < weekWindow.startDate || updateDate > weekWindow.endDate) {
			throw new Error('DM 券商债券申报更新日期超出周报区间');
		}
		const normalized = {
			projectName: requiredText(row.projectName, 'projectName'),
			issuerName: requiredText(row.issuerName, 'issuerName'),
			status: requiredText(row.status, 'status'),
			variety: requiredText(row.variety, 'variety'),
			amountYi: registrationAmount(row.amountYi),
			region: optionalText(row.region, 'region'),
			industry: optionalText(row.industry, 'industry'),
			leadUnderwriter: optionalText(row.leadUnderwriter, 'leadUnderwriter'),
			noticeNumber: optionalText(row.noticeNumber, 'noticeNumber'),
			venue: optionalText(row.venue, 'venue'),
			registrationOrFiling: optionalText(row.registrationOrFiling, 'registrationOrFiling'),
			updateDate
		};
		const key = [normalized.projectName, normalized.status, normalized.updateDate, normalized.noticeNumber ?? ''].join('|');
		unique.set(key, normalized);
	}
	return {
		status: 'available', path: '/broker-bond-registrations', request: registrationRequest,
		fields: REGISTRATION_FIELDS, rows: [...unique.values()]
	};
}

/** Rebuild and validate all browser-supplied report sources before persisting them. */
export function normalizeManualLiabilitySources(value, asOfDate) {
	const { issuanceWindow, weekWindow, ctrRequest, registrationRequest } = buildManualLiabilityRequests(asOfDate);
	const issuance = normalizeCtr(value?.ctr, ctrRequest, issuanceWindow, weekWindow);
	return {
		issuanceWindow,
		weekWindow,
		ctr: issuance.ctr,
		peerIssuances: issuance.peerIssuances,
		peerIssueSummary: issuance.peerIssueSummary,
		registration: normalizeRegistration(value?.registration, weekWindow, registrationRequest)
	};
}
