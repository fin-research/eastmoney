import { financingTimestamp, formatFinancingTimestamp } from './time.js';
import { DATA_ADMIN_DEBT_TYPES } from './debt-types.js';

export type DataRow = Record<string, unknown>;
export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'boolean' | 'json';

export type FieldConfig = {
	key: string;
	label: string;
	type?: FieldType;
	required?: boolean;
	readOnly?: boolean;
	table?: boolean;
	form?: boolean;
	step?: string;
	min?: number;
	max?: number;
	options?: Array<{ value: string; label: string }>;
	displayFactor?: number;
	omitWhenEmptyOnCreate?: boolean;
	emptyValue?: unknown;
};

export type EntityConfig = {
	key: string;
	label: string;
	tableName: string;
	primaryKeys: string[];
	fields: FieldConfig[];
	searchFields: string[];
	defaultSort: { key: string; direction: 'asc' | 'desc' };
	fixedValues?: DataRow;
	canCreate?: boolean;
	canDelete?: boolean;
	readOnly?: boolean;
};

const option = (value: string, label = value) => ({ value, label });

const commonTimestamps: FieldConfig[] = [
	{ key: 'created_at', label: '创建时间', type: 'datetime', readOnly: true, table: false, form: false },
	{ key: 'updated_at', label: '更新时间', type: 'datetime', readOnly: true, table: false, form: false }
];

const commonDebtFields: FieldConfig[] = [
	{ key: 'id', label: 'ID', type: 'number', readOnly: true },
	{ key: 'name', label: '负债简称', required: true },
	{ key: 'counterparty', label: '交易对手' },
	{ key: 'client_id', label: '客户 ID', type: 'number', min: 1, step: '1', table: false },
	{ key: 'amount', label: '本金（元）', type: 'number', required: true, min: 0, step: '0.01' },
	{ key: 'interest_payable', label: '应付利息（元）', type: 'number', min: 0, step: '0.01', omitWhenEmptyOnCreate: true },
	{ key: 'total_amount', label: '本息合计（元）', type: 'number', readOnly: true, form: false },
	{ key: 'annual_rate', label: '年利率（%）', type: 'number', min: 0, max: 100, step: '0.0001', displayFactor: 100 },
	{ key: 'issue_date', label: '起息日', type: 'date' },
	{ key: 'maturity_date', label: '到期日', type: 'date' },
	{ key: 'activated_at', label: '生效日', type: 'date' },
	{ key: 'settled_at', label: '结清日', type: 'date' },
	{ key: 'closed_at', label: '关闭日', type: 'date' },
	{ key: 'term_days', label: '期限（天）', type: 'number', readOnly: true, form: false },
	{ key: 'status', label: '状态', readOnly: true, form: false }
];

const debtExtraFields: Record<string, FieldConfig[]> = {
	bond: [
		{ key: 'issuance_method', label: '发行方式' },
		{ key: 'bookbuilding_date', label: '簿记日', type: 'date' },
		{ key: 'interest_basis', label: '计息基准' },
		{ key: 'issuance_target', label: '发行对象' },
		{ key: 'market', label: '市场' },
		{ key: 'receiving_account', label: '募集款账户' },
		{ key: 'trustee', label: '受托管理人' },
		{ key: 'bookrunner', label: '主承销商' }
	],
	income_certificate: [
		{ key: 'liquidation_submission_status', label: '清算报送状态' },
		{ key: 'liquidation_registration_status', label: '清算登记状态' },
		{ key: 'return_type', label: '收益类型' },
		{ key: 'subscription_date', label: '认购日', type: 'date' },
		{ key: 'redemption_date', label: '兑付日', type: 'date' },
		{ key: 'receiving_account', label: '收款账户' },
		{ key: 'early_maturity', label: '提前到期', type: 'boolean' }
	],
	income_right: [
		{ key: 'interest_basis_days', label: '计息基准天数', type: 'number', min: 1, step: '1' }
	],
	refinancing: [
		{ key: 'interest_basis_days', label: '计息基准天数', type: 'number', min: 1, step: '1' },
		{ key: 'market', label: '市场' },
		{ key: 'is_extended', label: '是否展期', type: 'boolean' },
		{ key: 'receiving_account', label: '收款账户' },
		{ key: 'repayment_account', label: '还款账户' }
	],
	swap_facility: [
		{ key: 'average_repo_balance_description', label: '回购余额说明' },
		{ key: 'repo_weighted_average_rate', label: '回购加权利率（%）', type: 'number', min: 0, max: 100, step: '0.0001', displayFactor: 100 }
	]
};

function debtTableName(debtType: string) {
	switch (debtType) {
		case '债券': return 'bond';
		case '收益凭证': return 'income_certificate';
		case '收益权转让': return 'income_right';
		case '转融资': return 'refinancing';
		case '互换便利': return 'swap_facility';
		default: return 'debt';
	}
}

export const DEBT_ENTITIES: EntityConfig[] = DATA_ADMIN_DEBT_TYPES.map((item, index) => {
	const tableName = debtTableName(item.type);
	const fields = [...commonDebtFields];
	if (item.subtypeOptions) {
		fields.splice(2, 0, {
			key: 'subtype',
			label: '收益类型',
			type: 'select',
			required: true,
			options: item.subtypeOptions.map((choice) => option(String(choice.value), choice.label))
		});
	}
	return {
		key: `debt-${index}`,
		label: item.label,
		tableName,
		primaryKeys: ['id'],
		searchFields: ['name', 'counterparty'],
		defaultSort: { key: 'issue_date', direction: 'desc' },
		fixedValues: {
			debt_type: item.type,
			...(item.filterSubtype ? { subtype: item.fixedSubtype } : {})
		},
		canCreate: true,
		canDelete: true,
		fields: [...fields, ...(debtExtraFields[tableName] ?? []), ...commonTimestamps]
	};
});

export const DATA_ENTITIES: EntityConfig[] = [
	...DEBT_ENTITIES,
	{
		key: 'monthly-finance', label: '月度财务数据', tableName: 'financial_monthly_data', primaryKeys: ['period_end'], searchFields: ['notes'],
		defaultSort: { key: 'period_end', direction: 'desc' }, canCreate: true, canDelete: true,
		fields: [
			{ key: 'period_end', label: '月末日期', type: 'date', required: true },
			{ key: 'net_capital', label: '净资本', type: 'number', step: '0.0001' },
			{ key: 'securities_net_assets', label: '证券净资产', type: 'number', step: '0.0001' },
			{ key: 'group_net_assets', label: '集团净资产', type: 'number', step: '0.0001' },
			{ key: 'total_assets', label: '总资产', type: 'number', min: 0, step: '0.0001' },
			{ key: 'total_liabilities', label: '总负债', type: 'number', min: 0, step: '0.0001' },
			{ key: 'agency_brokerage_funds', label: '代理买卖证券款', type: 'number', min: 0, step: '0.0001' },
			{ key: 'asset_liability_ratio', label: '资产负债率（%）', type: 'number', displayFactor: 100, readOnly: true, form: false },
			{ key: 'adjusted_asset_liability_ratio', label: '资产负债率（扣代理买卖，%）', type: 'number', displayFactor: 100, readOnly: true, form: false },
			{ key: 'notes', label: '来源与说明', type: 'textarea' },
			...commonTimestamps
		]
	},
	{
		key: 'parameter', label: '监管参数', tableName: 'finance_parameters', primaryKeys: ['code'], searchFields: ['code', 'label', 'notes'],
		defaultSort: { key: 'code', direction: 'asc' }, canCreate: false, canDelete: false, readOnly: true,
		fields: [
			{ key: 'code', label: '参数编码', readOnly: true },
			{ key: 'label', label: '参数名称', required: true },
			{ key: 'value_yi', label: '金额（亿元）', type: 'number', min: 0, step: '0.0001' },
			{ key: 'period_end', label: '口径日期', type: 'date' },
			{ key: 'notes', label: '说明', type: 'textarea' },
			...commonTimestamps
		]
	},
	{
		key: 'limit', label: '负债额度', tableName: 'debt_limit_configs', primaryKeys: ['debt_type'], searchFields: ['debt_type', 'usage_basis', 'calculation_mode'],
		defaultSort: { key: 'sort_order', direction: 'asc' }, canCreate: true, canDelete: true,
		fields: [
			{ key: 'debt_type', label: '负债品种', required: true },
			{ key: 'limit_yi', label: '额度（亿元）', type: 'number', required: true, min: 0, step: '0.0001' },
			{ key: 'usage_basis', label: '使用口径', type: 'select', required: true, options: [option('outstanding', '存量余额'), option('since_approval', '批复后累计')] },
			{ key: 'approved_date', label: '批复日期', type: 'date' },
			{ key: 'expiry_date', label: '到期日期', type: 'date' },
			{ key: 'calculation_mode', label: '计算方式', type: 'select', required: true, options: [option('manual', '手工额度'), option('net_capital_60', '净资本 60%')] },
			{ key: 'sort_order', label: '排序', type: 'number', step: '1', omitWhenEmptyOnCreate: true },
			...commonTimestamps
		]
	}
];

export function formatDataValue(field: FieldConfig, value: unknown) {
	if (value === null || value === undefined || value === '') return '—';
	if (field.type === 'boolean') return value ? '是' : '否';
	if (field.type === 'number') {
		const numeric = Number(value) * (field.displayFactor ?? 1);
		return Number.isFinite(numeric) ? numeric.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : String(value);
	}
	if (field.type === 'datetime') return formatFinancingTimestamp(String(value));
	if (field.type === 'json') return JSON.stringify(value);
	return String(value);
}

export function valueForEditor(field: FieldConfig, value: unknown) {
	if (value === null || value === undefined) return '';
	if (field.type === 'number' && field.displayFactor) return String(Number(value) * field.displayFactor);
	if (field.type === 'boolean') return Boolean(value);
	return String(value);
}

export function valueForDatabase(field: FieldConfig, value: unknown) {
	if (field.type === 'boolean') return Boolean(value);
	if (value === '' || value === null || value === undefined) return field.emptyValue ?? null;
	if (field.type === 'datetime') return financingTimestamp(String(value));
	if (field.type === 'number') {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) throw new Error(`${field.label}必须是有效数值`);
		return numeric / (field.displayFactor ?? 1);
	}
	return String(value).trim();
}

export const DATA_ADMIN_TABS = [
	{ id: 'management', label: '数据管理', href: '/financing/data' },
	...DEBT_ENTITIES.filter(config => !['科创债', '私募债', '收益权转让', '互换便利'].includes(config.label))
		.map(config => ({ id: config.key, label: config.label, href: `/financing/data?tab=${config.key}` }))
];

export function debtEditorFields(config: EntityConfig, mode: 'create' | 'edit') {
	return config.fields.filter(field => !field.readOnly && field.form !== false && !(mode === 'edit' && config.primaryKeys.includes(field.key)) && !(config.tableName === 'refinancing' && field.key === 'name'));
}

export function debtEditorPayload(config: EntityConfig, mode: 'create' | 'edit', values: DataRow) {
	const result: DataRow = {};
	for (const field of debtEditorFields(config, mode)) {
		const raw = values[field.key];
		if (mode === 'create' && field.omitWhenEmptyOnCreate && (raw === '' || raw == null)) continue;
		const value = valueForDatabase(field, raw);
		if (field.required && (value === null || value === '')) throw new Error(`请填写${field.label}`);
		if (typeof value === 'number' && ((field.min != null && Number(raw) < field.min) || (field.max != null && Number(raw) > field.max))) throw new Error(`${field.label}超出范围`);
		result[field.key] = value;
	}
	if (config.tableName === 'refinancing') result.name = '转融资';
	return result;
}
