/** Route incoming edges through one horizontal bus, regardless of source height. */
export function workflowEdgePath(sourceX: number, sourceY: number, targetX: number, targetY: number, joinY: number): string {
  if (Math.abs(targetX - sourceX) < 1) return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  const direction = Math.sign(targetX - sourceX);
  const firstDirection = Math.sign(joinY - sourceY), lastDirection = Math.sign(targetY - joinY);
  const radius = Math.min(8, Math.abs(targetX - sourceX) / 2, Math.abs(joinY - sourceY) / 2, Math.abs(targetY - joinY) / 2);
  return `M ${sourceX} ${sourceY} L ${sourceX} ${joinY - firstDirection * radius} Q ${sourceX} ${joinY} ${sourceX + direction * radius} ${joinY} L ${targetX - direction * radius} ${joinY} Q ${targetX} ${joinY} ${targetX} ${joinY + lastDirection * radius} L ${targetX} ${targetY}`;
}
