BEGIN;

SET LOCAL search_path TO financing, public;

-- Trial SOP for income-certificate issuance. T is the subscription date;
-- T' and T'' are kept in the node notes because the current project model
-- has one issue-date anchor and does not maintain a recurring interest date.
INSERT INTO sop_templates (id, name, debt_type, description, is_active)
VALUES (
	'sop-income-certificate',
	'收益凭证发行 SOP',
	'收益凭证',
	$$T 为认购日，T' 为到期日，T'' 为期间付息日，均为交易日。本试运行版按事项建立节点；T'、T'' 节点的实际日期先记录在节点备注中，项目详情可按实际安排调整截止日。$$,
	TRUE
)
ON CONFLICT (id) DO UPDATE SET
	name = EXCLUDED.name,
	debt_type = EXCLUDED.debt_type,
	description = EXCLUDED.description,
	is_active = TRUE,
	updated_at = CURRENT_TIMESTAMP;

INSERT INTO sop_nodes (
	id, template_id, name, description, sort_order, default_offset_days, default_owner_role
)
VALUES
	('income-certificate-01', 'sop-income-certificate', '前期准备｜沟通合同内容', $$阶段：前期准备阶段；时间：T-6前；事项：沟通合同内容。$$, 1, -6, NULL),
	('income-certificate-02', 'sop-income-certificate', '前期准备｜投资者反洗钱', $$阶段：前期准备阶段；时间：T-6前；事项：完成投资者反洗钱核查。$$, 2, -6, NULL),
	('income-certificate-03', 'sop-income-certificate', '前期准备｜专业投资者确认', $$阶段：前期准备阶段；时间：T-6前；事项：确认投资者符合专业投资者要求。$$, 3, -6, NULL),
	('income-certificate-04', 'sop-income-certificate', '前期准备｜确定合作意向', $$阶段：前期准备阶段；时间：T-6前；事项：确定合作意向并留痕。$$, 4, -6, NULL),
	('income-certificate-05', 'sop-income-certificate', '前期准备｜确认发行要素', $$阶段：前期准备阶段；时间：T-6前；事项：确认期限、收益、规模、募集对象等发行要素。$$, 5, -6, NULL),
	('income-certificate-06', 'sop-income-certificate', '内部发行准备｜拟定合同', $$阶段：内部发行准备阶段；时间：T-6；事项：拟定合同。$$, 6, -6, NULL),
	('income-certificate-07', 'sop-income-certificate', '内部发行准备｜合同用印', $$阶段：内部发行准备阶段；时间：T-5 12:00前；事项：完成合同用印。$$, 7, -5, NULL),
	('income-certificate-08', 'sop-income-certificate', '内部发行准备｜收益凭证注册', $$阶段：内部发行准备阶段；时间：合同用印后；事项：完成收益凭证注册。$$, 8, -5, NULL),
	('income-certificate-09', 'sop-income-certificate', '审批上架｜收益凭证配置（如需）', $$阶段：审批上架阶段；时间：T-5至T-1；事项：完成收益凭证配置（如需）。$$, 9, -5, NULL),
	('income-certificate-10', 'sop-income-certificate', '审批上架｜报价系统审批', $$阶段：审批上架阶段；时间：T-5至T-1；事项：完成报价系统审批。$$, 10, -5, NULL),
	('income-certificate-11', 'sop-income-certificate', '审批上架｜收益凭证上架（如需）', $$阶段：审批上架阶段；时间：T-3至T-1；事项：完成收益凭证上架（如需）。$$, 11, -3, NULL),
	('income-certificate-12', 'sop-income-certificate', '认购缴款｜收益凭证认购', $$阶段：认购缴款阶段；时间：T；事项：完成收益凭证认购。$$, 12, 0, NULL),
	('income-certificate-13', 'sop-income-certificate', '认购缴款｜资金入账', $$阶段：认购缴款阶段；时间：T+1；事项：确认资金入账。$$, 13, 1, NULL),
	('income-certificate-14', 'sop-income-certificate', '到期兑付｜提交兑付方案', $$阶段：到期兑付阶段；时间：T'-3前；事项：提交兑付方案；实际日期按项目到期日复核。$$, 14, 0, NULL),
	('income-certificate-15', 'sop-income-certificate', '到期兑付｜兑付资金划拨', $$阶段：到期兑付阶段；时间：T'-1前；事项：完成兑付资金划拨；实际日期按项目到期日复核。$$, 15, 0, NULL),
	('income-certificate-16', 'sop-income-certificate', '到期兑付｜完成到期兑付', $$阶段：到期兑付阶段；时间：T'；事项：完成到期兑付；实际日期按项目到期日复核。$$, 16, 0, NULL),
	('income-certificate-17', 'sop-income-certificate', '期间付息｜提交期间付息方案', $$阶段：期间付息阶段；时间：T''-3前；事项：提交期间付息方案；实际日期按期间付息日复核。$$, 17, 0, NULL),
	('income-certificate-18', 'sop-income-certificate', '期间付息｜付息资金划拨', $$阶段：期间付息阶段；时间：T''-2；事项：完成付息资金划拨；实际日期按期间付息日复核。$$, 18, 0, NULL),
	('income-certificate-19', 'sop-income-certificate', '期间付息｜完成期间付息', $$阶段：期间付息阶段；时间：T''-1；事项：完成期间付息；实际日期按期间付息日复核。$$, 19, 0, NULL)
ON CONFLICT (id) DO UPDATE SET
	template_id = EXCLUDED.template_id,
	name = EXCLUDED.name,
	description = EXCLUDED.description,
	sort_order = EXCLUDED.sort_order,
	default_offset_days = EXCLUDED.default_offset_days,
	default_owner_role = EXCLUDED.default_owner_role,
	updated_at = CURRENT_TIMESTAMP;

-- Existing income-certificate issuance plans were created before this SOP
-- existed. Bind only currently unbound plans, preserving any deliberate
-- existing template selection.
UPDATE projects
SET sop_template_id = 'sop-income-certificate',
	planned_start_date = COALESCE(planned_start_date, planned_issue_date - 6),
	updated_at = CURRENT_TIMESTAMP
WHERE debt_type = '收益凭证'
	AND sop_template_id IS NULL;

-- Generate the same task set that a newly-created project receives. Notes
-- carry the phase, timing and matter from the trial SOP into project detail.
INSERT INTO project_tasks (
	id, project_id, sop_node_id, name, status, assignee_id,
	planned_start_date, due_date, sort_order, notes
)
SELECT
	gen_random_uuid()::text,
	project.id,
	node.id,
	node.name,
	'not_started',
	NULL,
	project.planned_start_date,
	CASE WHEN project.planned_issue_date IS NULL THEN NULL
		ELSE project.planned_issue_date + node.default_offset_days END,
	node.sort_order,
	node.description
FROM projects project
JOIN sop_nodes node ON node.template_id = project.sop_template_id
WHERE project.debt_type = '收益凭证'
	AND project.sop_template_id = 'sop-income-certificate'
	AND NOT EXISTS (
		SELECT 1 FROM project_tasks existing
		WHERE existing.project_id = project.id AND existing.sop_node_id = node.id
	);

COMMIT;
