import type { CreditCalendarEvent } from './types.ts';

export const creditLimitFilterLabels: Record<string, string> = {
  new: '新增',
  expiry: '到期',
  renewal_or_increase: '续作/扩额',
  revoked: '撤销',
};

/** Each empty selection means all. The two groups filter their own event family. */
export function matchesCreditCalendarEvent(
  event: CreditCalendarEvent,
  limits: readonly string[],
  usage: readonly string[],
): boolean {
  if (event.type === 'usage') {
    return usage.length === 0 || (event.itemType != null && usage.includes(event.itemType));
  }
  if (limits.length === 0) return true;
  const category = event.kind === 'renewal' || event.kind === 'increase'
    ? 'renewal_or_increase'
    : event.kind;
  return limits.includes(category);
}
