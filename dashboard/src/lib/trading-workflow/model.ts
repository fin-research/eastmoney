import { z } from 'zod';
import { inquiryRowSchema } from './inquiries.ts';

export const products = [
  { id: 'loan', label: '拆借', enabled: true, tone: 'info' },
  { id: 'reverse', label: '逆回购', enabled: true, tone: 'success' },
  { id: 'exchange', label: '交易所回购', enabled: false, tone: 'warning' },
] as const;
export type Product = typeof products[number]['id'];
export type Scope = Product | 'shared';
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(id => !Object.prototype.hasOwnProperty.call(Object.prototype, id), '节点编号为保留名称');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const nodeSchema = z.object({
  id: idSchema,
  flowIds: z.array(z.enum(['loan', 'reverse', 'exchange'])).min(1, '至少选择一个所属流程').max(3),
  nextIds: z.array(idSchema).max(150),
  parentId: idSchema.nullable(),
  kind: z.enum(['task', 'branch']),
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().max(1200),
  startTime: timeSchema.nullable(),
  endTime: timeSchema.nullable(),
  offset: z.object({ x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) }).strict().optional(),
  inquiry: z.boolean().optional(),
  icon: z.enum(['file-text', 'message-square', 'git-branch', 'landmark', 'clock', 'send', 'clipboard-check', 'shield-check', 'banknote', 'wallet', 'building-2', 'calendar-clock', 'list-checks', 'check-check']).optional(),
}).strict();
export type WorkflowNode = z.infer<typeof nodeSchema>;
export const nodesSchema = z.array(nodeSchema).max(150).superRefine((nodes, ctx) => {
  const ids = new Set<string>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const [index, node] of nodes.entries()) {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: [index], message });
    if (ids.has(node.id)) fail('节点编号重复');
    ids.add(node.id);
    if (new Set(node.flowIds).size !== node.flowIds.length) fail('所属流程重复');
    if (new Set(node.nextIds).size !== node.nextIds.length) fail('后续节点重复');
    for (const next of node.nextIds) if (!byId.has(next) || next === node.id) fail('后续节点不存在或指向自身');
    if (node.endTime && (!node.startTime || node.endTime <= node.startTime)) fail('结束时间须晚于开始时间');
    if (node.kind === 'branch' && (node.startTime || node.endTime)) fail('条件分支不设置提醒时间');
    let parent = node.parentId;
    const ancestors = new Set([node.id]);
    let branchDepth = node.kind === 'branch' ? 1 : 0;
    while (parent) {
      const target = byId.get(parent);
      if (!target || target.kind !== 'branch' || !node.flowIds.some(id => target.flowIds.includes(id))) { fail('上级须为同品种条件分支'); break; }
      if (ancestors.has(parent) || ++branchDepth > 4) { fail('分支循环或超过四层'); break; }
      ancestors.add(parent);
      parent = target.parentId;
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    if (!(byId.get(id)?.nextIds ?? []).every(visit)) return false;
    visiting.delete(id); visited.add(id); return true;
  }
  if (!nodes.every(node => visit(node.id))) ctx.addIssue({ code: 'custom', message: '后续节点不能形成循环' });
});
export const flowsSchema = z.array(z.object({ id: z.enum(['loan', 'reverse', 'exchange']), label: z.string().trim().min(1).max(40) }).strict()).length(3).refine(flows => new Set(flows.map(flow => flow.id)).size === 3, '流程编号重复');
export const defaultFlows = products.map(({ id, label }) => ({ id, label }));
export const configSchema = z.object({ version: z.number().int().positive(), flows: flowsSchema, nodes: nodesSchema }).strict();
export type WorkflowConfig = z.infer<typeof configSchema>;
export const saveSchema = z.object({ expectedVersion: z.number().int().positive(), flows: flowsSchema, nodes: nodesSchema }).strict();
export const configResponseSchema = configSchema.extend({ actorKey: z.string().min(1), canEdit: z.boolean() });

export function shanghaiClock(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600_000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 19), minutes: Number(shifted.slice(11, 13)) * 60 + Number(shifted.slice(14, 16)) + Number(shifted.slice(17, 19)) / 60 };
}
export function minutes(time: string) { const [h, m] = time.split(':').map(Number); return h! * 60 + m!; }
export function childrenOf(nodes: WorkflowNode[], scope: Scope, parentId: string | null = null) {
  return orderedNodes(nodes).filter(node => nodeScope(node, nodes) === scope && node.parentId === parentId);
}
export function descendants(nodes: WorkflowNode[], id: string): Set<string> {
  const result = new Set([id]);
  for (let depth = 0; depth < 5; depth++) for (const node of nodes) if (node.parentId && result.has(node.parentId)) result.add(node.id);
  return result;
}
/** Stable topological order; array placement never creates a business connection. */
export function orderedNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const result: WorkflowNode[] = [], pending = [...nodes];
  while (pending.length) {
    const index = pending.findIndex(node => !pending.some(other => other.nextIds.includes(node.id)));
    if (index < 0) return nodes; // Invalid drafts are rejected before applying/saving.
    result.push(pending.splice(index, 1)[0]!);
  }
  return result;
}
export function nodeFlowIds(node: WorkflowNode, nodes: WorkflowNode[], seen = new Set<string>(), cache = new Map<string, Product[]>()): Product[] {
  const cached = cache.get(node.id);
  if (cached) return cached;
  if (seen.has(node.id)) return node.flowIds;
  const nextSeen = new Set(seen).add(node.id);
  const incoming = nodes.filter(item => item.nextIds.includes(node.id));
  const result = [...new Set([...node.flowIds, ...(incoming.length > 1 ? incoming.flatMap(item => nodeFlowIds(item, nodes, nextSeen, cache)) : [])])];
  cache.set(node.id, result);
  return result;
}
/** Shared is a graph presentation property, never a fourth workflow. */
export function nodeScope(node: WorkflowNode, nodes: WorkflowNode[]): Scope {
  return nodeFlowIds(node, nodes).length > 1 || nodes.filter(item => item.nextIds.includes(node.id)).length > 1 ? 'shared' : node.flowIds[0]!;
}
export function flowLabel(node: WorkflowNode, nodes: WorkflowNode[], flows: { id: Product; label: string }[] = defaultFlows) {
  return nodeFlowIds(node, nodes).map(id => flows.find(flow => flow.id === id)?.label ?? id).join('、');
}
/** Delete only this node, splice its outgoing edges into incoming edges, promote conditional children. */
export function removeNode(nodes: WorkflowNode[], id: string): WorkflowNode[] {
  const removed = nodes.find(node => node.id === id);
  if (!removed) return nodes;
  return nodes.filter(node => node.id !== id).map(node => ({ ...node,
    parentId: node.parentId === id ? removed.parentId : node.parentId,
    nextIds: [...new Set(node.nextIds.flatMap(next => next === id ? removed.nextIds : [next]))].filter(next => next !== node.id),
  }));
}
/** Swap adjacent main steps while leaving each conditional subtree attached to its own branch. */
export function moveNode(nodes: WorkflowNode[], id: string, direction: -1 | 1): WorkflowNode[] {
  const node = nodes.find(item => item.id === id);
  if (!node) return nodes;
  const candidates = direction === 1 ? nodes.filter(item => node.nextIds.includes(item.id)) : nodes.filter(item => item.nextIds.includes(id));
  const siblings = candidates.filter(item => item.parentId === node.parentId && item.flowIds.join() === node.flowIds.join());
  if (siblings.length !== 1) return nodes;
  const other = siblings[0]!, a = direction === 1 ? node : other, b = direction === 1 ? other : node;
  const mainNext = (item: WorkflowNode) => item.nextIds.filter(next => nodes.find(candidate => candidate.id === next)?.parentId !== item.id);
  if (mainNext(a).length !== 1 || nodes.filter(item => item.nextIds.includes(b.id)).length !== 1) return nodes;
  return nodes.map(item => ({ ...item, nextIds: item.id === a.id
    ? [...item.nextIds.filter(next => next !== b.id), ...mainNext(b)]
    : item.id === b.id ? [...item.nextIds.filter(next => !mainNext(b).includes(next)), a.id]
    : item.nextIds.map(next => next === a.id ? b.id : next) }));
}
export function insertNode(nodes: WorkflowNode[], source: WorkflowNode, child: WorkflowNode): WorkflowNode[] {
  const branch = source.kind === 'branch';
  const outgoing = source.nextIds.filter(id => nodes.find(node => node.id === id)?.parentId === (branch ? source.id : source.parentId));
  return [...nodes.map(node => node.id === source.id ? { ...node, nextIds: [...node.nextIds.filter(id => !outgoing.includes(id)), child.id] } : node),
    { ...child, nextIds: outgoing }];
}

/** Move a node with its conditional subtree, reconnecting the path it leaves. */
export function reparentNode(nodes: WorkflowNode[], id: string, parentId: string | null): WorkflowNode[] {
  const selected = nodes.find(node => node.id === id);
  if (!selected || selected.parentId === parentId) return nodes;
  const continuation = selected.nextIds.filter(next => nodes.find(node => node.id === next)?.parentId === selected.parentId);
  const side = selected.nextIds.filter(next => !continuation.includes(next));
  const next = nodes.map(node => ({ ...node,
    parentId: node.id === id ? parentId : node.parentId,
    nextIds: node.id === id ? side : [...new Set(node.nextIds.flatMap(target => target === id ? continuation : [target]))],
  }));
  const parent = next.find(node => node.id === parentId);
  if (parent) {
    const entries = parent.nextIds.filter(target => next.find(node => node.id === target)?.parentId === parentId);
    parent.nextIds = [...parent.nextIds.filter(target => !entries.includes(target)), id];
    next.find(node => node.id === id)!.nextIds = [...new Set([...side, ...entries])];
  }
  return next;
}

const flags = z.record(z.string(), z.boolean());
export const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  enabled: z.object({ loan: z.boolean(), reverse: z.boolean(), exchange: z.boolean() }),
  completed: flags, branches: flags, notified: flags,
  quotes: z.record(z.string(), z.array(inquiryRowSchema).max(500)).default({}),
  notes: z.record(z.string(), z.string().max(4000)).default({}),
}).strict();
export type WorkflowDay = z.infer<typeof daySchema>;
export function emptyDay(date: string): WorkflowDay {
  return { date, enabled: { loan: true, reverse: true, exchange: false }, completed: {}, branches: {}, notified: {}, notes: {}, quotes: {} };
}
export function isActive(node: WorkflowNode, nodes: WorkflowNode[], day: WorkflowDay): boolean {
  if (nodeScope(node, nodes) !== 'shared' && !nodeFlowIds(node, nodes).some(id => day.enabled[id])) return false;
  let parent = node.parentId;
  for (let depth = 0; parent && depth < 5; depth++) {
    if (!day.branches[parent]) return false;
    const ancestor = nodes.find(candidate => candidate.id === parent);
    if (!ancestor) return false;
    parent = ancestor.parentId;
  }
  return !parent;
}
export function activeTasks(nodes: WorkflowNode[], day: WorkflowDay, scope?: Scope) {
  return nodes.filter(node => node.kind === 'task' && !isInquiry(node) && (!scope || nodeScope(node, nodes) === scope) && isActive(node, nodes, day));
}
export function dueReminders(nodes: WorkflowNode[], day: WorkflowDay, now: Date, channel: string) {
  const clock = shanghaiClock(now);
  if (clock.date !== day.date) return [];
  return activeTasks(nodes, day).flatMap(node => {
    if (day.completed[node.id]) return [];
    // An overdue time window produces one closing reminder, not two stale alerts.
    const time = node.endTime && minutes(node.endTime) <= clock.minutes ? node.endTime : node.startTime;
    if (!time || minutes(time) > clock.minutes) return [];
    const key = `${channel}:${node.id}:${time}`;
    return day.notified[key] ? [] : [{ node, time, key }];
  });
}

export function dayKey(actorKey: string, date: string) { return `eastmoney:trading-workflow:v1:${encodeURIComponent(actorKey)}:${date}`; }
export function readDay(storage: Pick<Storage, 'getItem'>, key: string, date: string): WorkflowDay {
  const raw = storage.getItem(key);
  if (!raw) return emptyDay(date);
  const parsed = daySchema.parse(JSON.parse(raw));
  return parsed.date === date ? parsed : emptyDay(date);
}
/** Always merge against the latest local value before changing a field. Never sends progress to an API. */
export function updateDay(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, date: string, change: (day: WorkflowDay) => void): WorkflowDay {
  const day = readDay(storage, key, date);
  change(day);
  storage.setItem(key, JSON.stringify(daySchema.parse(day)));
  return day;
}

export function isInquiry(node: WorkflowNode) {
  return node.inquiry ?? ['loan-quote', 'reverse-quote'].includes(node.id);
}
