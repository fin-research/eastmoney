import { z } from 'zod';
import { nodeSchema, nodesSchema, products } from './model.ts';

const legacyNodeSchema = nodeSchema.omit({ flowIds: true, nextIds: true }).extend({ scope: z.enum(['loan', 'reverse', 'exchange', 'shared']) }).strict();
/** Read-only compatibility for configurations written before explicit graph links. */
export function migrateLegacyNodes(value: unknown) {
  const legacy = z.array(legacyNodeSchema).max(150).parse(value);
  const children = (scope: string, parentId: string | null = null) => legacy.filter(node => node.scope === scope && node.parentId === parentId);
  const next = new Map(legacy.map(node => [node.id, new Set<string>()]));
  const connect = (ids: string[]) => ids.slice(1).forEach((id, index) => next.get(ids[index]!)!.add(id));
  const shared = children('shared');
  const closingIndex = shared.findIndex(node => node.id === 'shared-done');
  const opening = closingIndex < 0 ? shared : shared.slice(0, closingIndex);
  const closing = closingIndex < 0 ? [] : shared.slice(closingIndex);
  const firstTime = opening.find(node => node.startTime)?.startTime;
  for (const product of products) {
    const lane = children(product.id);
    let prefix = 0;
    while (prefix < lane.length && lane[prefix]!.kind === 'task' && lane[prefix]!.startTime && firstTime && lane[prefix]!.startTime! < firstTime) prefix++;
    connect([...lane.slice(0, prefix), ...opening, ...lane.slice(prefix), ...closing].map(node => node.id));
  }
  for (const node of legacy.filter(node => node.kind === 'branch')) connect([node.id, ...children(node.scope, node.id).map(child => child.id)]);
  function reaches(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...next.get(from) ?? []].some(id => reaches(id, target, seen));
  }
  for (const node of shared) for (const target of [...next.get(node.id)!]) {
    if (shared.some(item => item.id === target) && [...next.get(node.id)!].some(other => other !== target && reaches(other, target))) next.get(node.id)!.delete(target);
  }
  return nodesSchema.parse(legacy.map(({ scope, ...node }) => ({ ...node, flowIds: scope === 'shared' ? products.map(product => product.id) : [scope], nextIds: [...next.get(node.id)!] })));
}
