BEGIN;

SET LOCAL search_path TO financing, public;

-- Correct the maturity-day notation in the already-applied trial SOP.
UPDATE sop_nodes
SET description = CASE id
	WHEN 'income-certificate-14' THEN $$阶段：到期兑付阶段；时间：T'-3前；事项：提交兑付方案；实际日期按项目到期日复核。$$
	WHEN 'income-certificate-15' THEN $$阶段：到期兑付阶段；时间：T'-1前；事项：完成兑付资金划拨；实际日期按项目到期日复核。$$
	WHEN 'income-certificate-16' THEN $$阶段：到期兑付阶段；时间：T'；事项：完成到期兑付；实际日期按项目到期日复核。$$
	ELSE description
END,
	updated_at = CURRENT_TIMESTAMP
WHERE id IN ('income-certificate-14', 'income-certificate-15', 'income-certificate-16')
	AND template_id = 'sop-income-certificate';

UPDATE project_tasks task
SET notes = node.description,
	updated_at = CURRENT_TIMESTAMP
FROM sop_nodes node
WHERE node.id = task.sop_node_id
	AND node.id IN ('income-certificate-14', 'income-certificate-15', 'income-certificate-16')
	AND node.template_id = 'sop-income-certificate';

COMMIT;
