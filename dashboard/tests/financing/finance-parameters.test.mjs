import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { FINANCE_PARAMETER_CONFIG, financeParameterPayload, financialReconciliation, financialValue, monthEnd } = await tsImport('../../src/lib/financing/finance-parameters.ts', import.meta.url);

test('monthly financial input keeps amount units, canonical month ends and excludes generated columns', () => {
	const payload = financeParameterPayload('2026-08', { total_assets: '1234.5678', asset_liability_ratio: '99' }, ' 月末财务报表 ');
	assert.equal(FINANCE_PARAMETER_CONFIG.tableName, 'financial_monthly_data');
	assert.deepEqual(FINANCE_PARAMETER_CONFIG.primaryKeys, ['period_end']);
	assert.equal(payload.total_assets, 1234.5678);
	assert.equal(payload.period_end, '2026-08-31');
	assert.equal(payload.notes, '月末财务报表');
	assert.equal(payload.total_liabilities, null);
	assert.equal('asset_liability_ratio' in payload, false);
	assert.equal(monthEnd('2024-02'), '2024-02-29');
	assert.equal(monthEnd('2026-02'), '2026-02-28');
	assert.equal(financialValue(0), '0 亿元');
	assert.equal(financialValue(null), '暂无数据');
	assert.equal(financialValue(0, false, { unit: false }), '0');
	assert.equal(financialValue(null, false, { unit: false }), '暂无数据');
	assert.equal(financialValue('4636.3417', false, { unit: false }), '4,636.3417');
	assert.equal(financialValue('0.7167', true, { unit: false }), '71.67');
});

test('ratio previews and equity reconciliation use the same month and distinguish missing values from zero', () => {
	const result = financialReconciliation({ total_assets: 100, total_liabilities: 70, agency_brokerage_funds: 20, securities_net_assets: 30 });
	assert.equal(result.asset_liability_ratio, 0.7);
	assert.equal(result.adjusted_asset_liability_ratio, 0.625);
	assert.equal(result.difference, 0);
	assert.equal(financialValue(result.adjusted_asset_liability_ratio, true), '62.5%');
	assert.equal(financialReconciliation({ total_assets: 100, total_liabilities: 0 }).asset_liability_ratio, 0);
	assert.equal(financialReconciliation({ total_assets: 0, total_liabilities: 0 }).asset_liability_ratio, null);
	assert.equal(financialReconciliation({ total_assets: 100, total_liabilities: '' }).asset_liability_ratio, null);
	assert.equal(financialReconciliation({ total_assets: 100, total_liabilities: 100, agency_brokerage_funds: 100 }).adjusted_asset_liability_ratio, null);
});

test('monthly financial validation rejects invalid amounts and agent-funds inconsistencies', () => {
	for (const value of ['-1', 'NaN', 'Infinity']) {
		assert.throws(() => financeParameterPayload('2026-08', { total_assets: value }, ''));
	}
	assert.throws(() => financeParameterPayload('2026-08', {}, ''), /至少填写/);
	assert.throws(() => financeParameterPayload('2026-08', { total_assets: '100', agency_brokerage_funds: '101' }, ''), /不能超过/);
	assert.equal(financeParameterPayload('2026-08', { securities_net_assets: '-10' }, '').securities_net_assets, -10);
	for (const month of ['', '2026-13', '2026-00']) assert.throws(() => monthEnd(month), /有效的月份/);
});
