import type { ShiborRate } from '../../data-contracts.ts';
import type { InquiryRow, InquiryDirectory } from './inquiries.ts';
import type { Node, Edge } from '@xyflow/svelte';
import { descendants, nodeScope, isInquiry, minutes, products, type Scope, type Product, type WorkflowNode, type WorkflowDay } from './model.ts';

export const NODE_WIDTH = 460;
export const VERTICAL_GAP = 76;
export type FlowEdge = Edge<{ joinY: number; side?: boolean }, 'workflow'>;
export type FlowData = {
  title: string; scope: Scope; node?: WorkflowNode; members?: WorkflowNode[]; width: number;
  rows: InquiryRow[]; directory: InquiryDirectory; rates: ShiborRate[]; date: string; now: Date;
  writeRows: (rows: InquiryRow[]) => void; remember: (row: InquiryRow) => void;
  done?: boolean; active?: boolean; expanded?: boolean; editing: boolean; selected?: boolean;
  reveal?: number; note?: string; measureHeight?: (height: number) => void;
  activate: () => void; writeNote: (value: string) => void; complete?: () => void;
};
export type FlowNode = Node<FlowData, 'workflow'>;
export type TimelineMark = { time: string; minute: number; y: number; endX: number };
export type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[]; bases: Record<string, { x: number; y: number }>; timeline: TimelineMark[]; height: number; width: number; lanes: Partial<Record<Product, { x: number; width: number }>> };

/** Product ownership is explicit; identical labels never merge distinct nodes. */
export function workflowGroups(config: WorkflowNode[]): WorkflowNode[][] {
  return config.map(node => [node]);
}

export function nodeComplete(node: WorkflowNode, config: WorkflowNode[], day: WorkflowDay): boolean {
  if (isInquiry(node)) return false;
  if (node.kind === 'task') return !!day.completed[node.id];
  const ids = descendants(config, node.id);
  const tasks = config.filter(item => ids.has(item.id) && item.kind === 'task' && !isInquiry(item));
  return tasks.length > 0 && tasks.every(item => day.completed[item.id]);
}

export function buildGraph(config: WorkflowNode[], day: WorkflowDay, options: {
  editing: boolean; selectedId: string; clockMinutes: number; width?: number; heights?: Record<string, number>;
  inquiries?: Record<string, boolean>; measureHeight?: (id: string, height: number) => void;
  activate: (node: WorkflowNode, members: WorkflowNode[]) => void; toggleProduct: (product: Product) => void;
  rows?: (id: string, rows: InquiryRow[]) => void; directory?: InquiryDirectory; rates?: ShiborRate[]; now?: Date; remember?: (row: InquiryRow) => void;
  note: (id: string, value: string) => void; complete?: (members: WorkflowNode[]) => void;
}): FlowGraph {
  const scopeOf = (node: WorkflowNode) => nodeScope(node, config);
  const enabled = products.filter(product => day.enabled[product.id]);
  const depth = (node: WorkflowNode): number => node.parentId ? 1 + depth(config.find(item => item.id === node.parentId)!) : 0;
  const parentsActive = (node: WorkflowNode): boolean => !node.parentId || (!!day.branches[node.parentId] && parentsActive(config.find(item => item.id === node.parentId)!));
  const visibleConfig = config.filter(node => parentsActive(node) && (scopeOf(node) === 'shared' || node.flowIds.some(id => day.enabled[id])));
  const columns = new Map<Scope, number>([...enabled.map(product => [product.id, 1 + Math.max(0, ...visibleConfig.filter(node => scopeOf(node) === product.id).map(depth))] as [Scope, number]),
    ['shared', Math.max(0, ...visibleConfig.filter(node => scopeOf(node) === 'shared').map(depth))]]);
  const slots = Math.max(1, [...columns.values()].reduce((sum, value) => sum + value, enabled.length ? 0 : 1));
  const width = Math.max(170 + slots * 360, options.width ?? 1040);
  const graph: FlowGraph = { nodes: [], edges: [], bases: {}, timeline: [], height: 0, width, lanes: {} };
  const areaLeft = 134, column = (width - areaLeft - 24) / slots;
  const nodeWidth = Math.min(NODE_WIDTH, column - 36);
  let slot = enabled.length ? 0 : 1;
  for (const product of enabled) {
    graph.lanes[product.id] = { x: areaLeft + slot * column + (column - nodeWidth) / 2, width: nodeWidth };
    slot += columns.get(product.id)!;
  }
  const laneX = (scope: Scope) => scope === 'shared' ? center : graph.lanes[scope]?.x ?? areaLeft;
  const centers = enabled.map(product => graph.lanes[product.id]!.x);
  const center = centers.length ? (centers[0]! + centers.at(-1)!) / 2 : areaLeft + (column - nodeWidth) / 2;
  const sideX = (node: WorkflowNode) => scopeOf(node) === 'shared' && node.parentId
    ? areaLeft + (slot + depth(node) - 1) * column + (column - nodeWidth) / 2
    : laneX(scopeOf(node)) + depth(node) * column;
  const allGroups = workflowGroups(config);
  const byId = new Map(allGroups.flatMap(group => group.map(node => [node.id, group] as const)));
  const expanded = (group: WorkflowNode[]) => group.some(node => day.branches[node.id]);
  function parentsOpen(node: WorkflowNode): boolean {
    if (!node.parentId) return true;
    const parent = byId.get(node.parentId);
    return !!parent && expanded(parent) && parentsOpen(parent[0]!);
  }
  // Shared steps survive product folding; only their own conditional parent can hide them.
  const groups = allGroups.filter(group => parentsOpen(group[0]!) && (group.length > 1 || scopeOf(group[0]!) === 'shared' || group[0]!.flowIds.some(id => day.enabled[id])));
  const visible = new Map(groups.flatMap(group => group.map(node => [node.id, group[0]!.id] as const)));
  const incoming = new Map<string, Set<string>>(groups.map(group => [group[0]!.id, new Set()]));
  const sideEdges = new Set<string>();
  for (const source of config) {
    if (!visible.has(source.id)) continue;
    for (const targetId of source.nextIds) {
      if (!visible.has(targetId)) continue;
      incoming.get(targetId)!.add(source.id);
      if (config.find(node => node.id === targetId)?.parentId === source.id) sideEdges.add(`${source.id}:${targetId}`);
    }
  }
  const railBottom = new Map<number, number>();
  function connect(source: string, target: string, joinY: number) {
    const from = graph.nodes.find(node => node.id === source)!, to = graph.nodes.find(node => node.id === target)!;
    const scope = to.data.scope === 'shared' ? from.data.scope : to.data.scope;
    const color = scope === 'reverse' ? '#00a773' : scope === 'exchange' ? '#8090aa' : '#087cff';
    graph.edges.push({ id: `${source}:${target}`, source, target, type: 'workflow', sourceHandle: sideEdges.has(`${source}:${target}`) ? 'side' : 'bottom', targetHandle: sideEdges.has(`${source}:${target}`) ? 'side' : 'top', data: { joinY, side: sideEdges.has(`${source}:${target}`) },
      markerEnd: { type: 'arrowclosed' as import('@xyflow/svelte').MarkerType, width: 16, height: 16, color }, style: `stroke: ${color}; stroke-width: 1.8;` });
  }
  const pending = [...groups];
  while (pending.length) {
    const index = pending.findIndex(group => [...incoming.get(group[0]!.id)!].every(id => graph.nodes.some(node => node.id === id)));
    if (index < 0) throw new Error('交易流程存在循环连线');
    const members = pending.splice(index, 1)[0]!, node = members.find(item => item.id === options.selectedId) ?? members[0]!;
    const id = members[0]!.id, scope = members.length > 1 ? 'shared' : scopeOf(node);
    const x = sideX(node);
    const predecessors = [...incoming.get(id)!].map(id => graph.nodes.find(node => node.id === id)!);
    const y = Math.max(104, railBottom.get(x) ?? 0, ...predecessors.map(previous => (graph.bases[previous.id]?.y ?? previous.position.y) + (sideEdges.has(`${previous.id}:${id}`) ? 0 : previous.measured!.height! + VERTICAL_GAP)));
    graph.bases[id] = { x, y };
    const offset = members[0]!.offset;
    const position = { x: x + (offset?.x ?? 0), y: y + (offset?.y ?? 0) };
    const open = isInquiry(node) ? !!options.inquiries?.[id] : expanded(members);
    const estimate = 52 + (node.detail ? Math.ceil(node.detail.length / Math.max(12, (nodeWidth - 65) / 15)) * 23 : 0) + (isInquiry(node) && open ? 56 + (day.quotes[node.id]?.length ?? 0) * 39 : 0);
    const height = options.heights?.[id] ?? estimate;
    railBottom.set(x, y + height + VERTICAL_GAP);
    const done = members.every(item => nodeComplete(item, config, day));
    graph.nodes.push({ id, type: 'workflow', position, width: nodeWidth, measured: { width: nodeWidth, height }, focusable: false, draggable: options.editing, connectable: false,
      data: { node, members, rows: day.quotes[node.id] ?? [], directory: options.directory ?? { counterparties: [], traders: [] }, rates: options.rates ?? [], date: day.date, now: options.now ?? new Date(),
        writeRows: rows => options.rows?.(node.id, rows), remember: row => options.remember?.(row), title: isInquiry(node) ? '询价' : node.title, width: nodeWidth, scope, active: true, done, expanded: open,
        editing: options.editing, selected: members.some(item => item.id === options.selectedId),
        measureHeight: height => options.measureHeight?.(id, height), note: day.notes[node.id] ?? '',
        activate: () => options.activate(node, members), complete: () => options.complete?.(members), writeNote: value => options.note(node.id, value) } });
    const joinY = position.y - VERTICAL_GAP / 2;
    for (const predecessor of predecessors) connect(predecessor.id, id, joinY);
  }
  const candidates = graph.nodes.filter(node => node.data.node?.startTime).map(node => ({
    time: node.data.node!.startTime!, minute: minutes(node.data.node!.startTime!), y: node.position.y + node.measured!.height! / 2, endX: node.position.x - 8,
  }));
  for (const mark of candidates.sort((a, b) => a.y - b.y)) if (!graph.timeline.length || mark.minute > graph.timeline.at(-1)!.minute) graph.timeline.push(mark);
  graph.height = Math.max(680, ...graph.nodes.map(node => node.position.y + node.measured!.height! + 48));
  return graph;
}

export function timelineCursor(marks: TimelineMark[], minute: number): number | null {
  if (!marks.length) return null;
  if (minute <= marks[0]!.minute) return marks[0]!.y;
  const next = marks.findIndex(mark => mark.minute > minute);
  if (next < 0) return marks.at(-1)!.y;
  const a = marks[next - 1]!, b = marks[next]!;
  return a.y + (b.y - a.y) * (minute - a.minute) / (b.minute - a.minute);
}

/** Frame each expanded sibling rail; nested branches get their own adjacent frame. */
export function workflowBranchFrames(nodes: FlowNode[]) {
  return nodes.flatMap(parent => {
    const children = nodes.filter(node => node.data.node?.parentId === parent.id);
    if (!children.length) return [];
    const left = Math.min(...children.map(node => node.position.x)) - 14;
    const top = Math.min(...children.map(node => node.position.y)) - 14;
    const right = Math.max(...children.map(node => node.position.x + node.data.width)) + 14;
    const bottom = Math.max(...children.map(node => node.position.y + (node.measured?.height ?? 52))) + 14;
    return [{ id: parent.id, title: parent.data.title, scope: parent.data.scope, left, top,
      width: right - left, height: bottom - top, opacity: Math.max(...children.map(node => node.data.reveal ?? 1)) }];
  });
}
