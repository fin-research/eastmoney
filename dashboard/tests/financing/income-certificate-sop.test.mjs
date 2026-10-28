import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../../financing-migrations/0011_income_certificate_sop.sql', import.meta.url);

test('income-certificate trial SOP contains every non-empty SOP matter and binds existing plans', async () => {
	const source = await readFile(migrationPath, 'utf8');
	const matters = [
		'沟通合同内容', '投资者反洗钱', '专业投资者确认', '确定合作意向', '确认发行要素',
		'拟定合同', '合同用印', '收益凭证注册', '收益凭证配置（如需）', '报价系统审批',
		'收益凭证上架（如需）', '收益凭证认购', '资金入账', '提交兑付方案', '兑付资金划拨',
		'完成到期兑付', '提交期间付息方案', '付息资金划拨', '完成期间付息'
	];

	assert.equal((source.match(/income-certificate-\d{2}/g) ?? []).length, matters.length);
	for (const matter of matters) assert.match(source, new RegExp(matter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(source, /UPDATE projects[\s\S]*?debt_type = '收益凭证'[\s\S]*?sop_template_id IS NULL/);
	assert.match(source, /INSERT INTO project_tasks[\s\S]*?node\.description/);
});
