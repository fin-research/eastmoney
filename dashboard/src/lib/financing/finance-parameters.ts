import { DATA_ENTITIES, valueForDatabase, type DataRow } from './data-admin';

export const FINANCE_PARAMETER_CONFIG = DATA_ENTITIES.find((entity) => entity.key === 'monthly-finance')!;
export const FINANCIAL_INPUT_FIELDS = FINANCE_PARAMETER_CONFIG.fields.filter((field) => field.type === 'number' && !field.readOnly);
export const FINANCIAL_RATIO_FIELDS = FINANCE_PARAMETER_CONFIG.fields.filter((field) => field.type === 'number' && field.readOnly);

export function monthEnd(month: string) {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900) throw new Error('请选择有效的月份');
	const date = new Date(`${month}-01T00:00:00Z`);
	date.setUTCMonth(date.getUTCMonth() + 1, 0);
	return date.toISOString().slice(0, 10);
}

export function financeParameterPayload(month: string, values: Record<string, string>, notes: string): DataRow {
	const payload: DataRow = { period_end: monthEnd(month), notes: notes.trim() || null };
	for (const field of FINANCIAL_INPUT_FIELDS) {
		const raw = (values[field.key] ?? '').trim();
		const value = valueForDatabase(field, raw);
		if (typeof value === 'number' && (Math.abs(value) >= 1e16 || (field.min != null && value < field.min))) {
			throw new Error(`${field.label}超出允许范围`);
		}
		payload[field.key] = value;
	}
	if (FINANCIAL_INPUT_FIELDS.every((field) => payload[field.key] == null)) throw new Error('请至少填写一项财务数据');
	const agency = payload.agency_brokerage_funds as number | null;
	for (const key of ['total_assets', 'total_liabilities']) {
		if (agency != null && payload[key] != null && agency > Number(payload[key])) throw new Error('代理买卖证券款不能超过总资产或总负债');
	}
	return payload;
}

export function financialReconciliation(row: DataRow) {
	const numeric = (key: string) => row[key] == null || row[key] === '' || !Number.isFinite(Number(row[key])) ? null : Number(row[key]);
	const assets = numeric('total_assets');
	const liabilities = numeric('total_liabilities');
	const agency = numeric('agency_brokerage_funds');
	const equity = numeric('securities_net_assets');
	const ratio = assets != null && assets !== 0 && liabilities != null ? liabilities / assets : null;
	const adjusted = assets != null && liabilities != null && agency != null && assets > agency && liabilities >= agency
		? (liabilities - agency) / (assets - agency) : null;
	const difference = assets != null && liabilities != null && equity != null ? assets - liabilities - equity : null;
	return { asset_liability_ratio: ratio, adjusted_asset_liability_ratio: adjusted, difference };
}

export function hasFinancialValue(value: unknown): boolean {
	return value != null && value !== '' && Number.isFinite(Number(value));
}

export function financialValue(value: unknown, ratio = false, options: { unit?: boolean } = {}) {
	if (!hasFinancialValue(value)) return '暂无数据';
	const unit = options.unit === false ? '' : ratio ? '%' : ' 亿元';
	return `${(Number(value) * (ratio ? 100 : 1)).toLocaleString('zh-CN', { maximumFractionDigits: ratio ? 2 : 4 })}${unit}`;
}
