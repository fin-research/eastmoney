import { migrateLegacyNodes } from '../trading-workflow/legacy.ts';
import { configSchema, defaultFlows, saveSchema, type WorkflowConfig } from '../trading-workflow/model.ts';

export class WorkflowConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export async function readWorkflowConfig(db: Env["DB"]): Promise<WorkflowConfig> {
  const row = await db.prepare('SELECT version, nodes FROM trading_workflow_config WHERE id = 1').first<{ version: number; nodes: string }>();
  if (!row) throw new WorkflowConfigError(503, '交易流程配置尚未初始化');
  return parseStored(row);
}
export async function saveWorkflowConfig(db: Env["DB"], input: unknown): Promise<WorkflowConfig> {
  const value = saveSchema.parse(input);
  const row = await db.prepare('UPDATE trading_workflow_config SET nodes = ?, version = version + 1 WHERE id = 1 AND version = ? RETURNING version, nodes')
    .bind(JSON.stringify({ flows: value.flows, nodes: value.nodes }), value.expectedVersion).first<{ version: number; nodes: string }>();
  if (!row) throw new WorkflowConfigError(409, '节点配置已被更新，请重新载入后修改');
  return parseStored(row);
}

function parseStored(row: { version: number; nodes: string }): WorkflowConfig {
  try {
    const stored = JSON.parse(row.nodes);
    return configSchema.parse(Array.isArray(stored)
      ? { version: row.version, flows: defaultFlows, nodes: migrateLegacyNodes(stored) }
      : { ...stored, version: row.version });
  }
  catch { throw new WorkflowConfigError(503, "交易流程配置损坏，请联系管理员"); }
}
