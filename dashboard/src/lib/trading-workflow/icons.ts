import Banknote from '@lucide/svelte/icons/banknote';
import Building2 from '@lucide/svelte/icons/building-2';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import CheckCheck from '@lucide/svelte/icons/check-check';
import ClipboardCheck from '@lucide/svelte/icons/clipboard-check';
import Clock from '@lucide/svelte/icons/clock';
import FileText from '@lucide/svelte/icons/file-text';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Landmark from '@lucide/svelte/icons/landmark';
import ListChecks from '@lucide/svelte/icons/list-checks';
import MessageSquare from '@lucide/svelte/icons/message-square';
import Send from '@lucide/svelte/icons/send';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Wallet from '@lucide/svelte/icons/wallet';
import { isInquiry, type WorkflowNode } from './model';

export const workflowIcons = {
  'file-text': { label: '单据', component: FileText },
  'message-square': { label: '询价', component: MessageSquare },
  'git-branch': { label: '分支', component: GitBranch },
  landmark: { label: '银行', component: Landmark },
  clock: { label: '等待', component: Clock },
  send: { label: '发送', component: Send },
  'clipboard-check': { label: '审批', component: ClipboardCheck },
  'shield-check': { label: '核验', component: ShieldCheck },
  banknote: { label: '资金', component: Banknote },
  wallet: { label: '账户', component: Wallet },
  'building-2': { label: '机构', component: Building2 },
  'calendar-clock': { label: '时点', component: CalendarClock },
  'list-checks': { label: '清单', component: ListChecks },
  'check-check': { label: '完成', component: CheckCheck },
} as const;

export function nodeIcon(node?: WorkflowNode) {
  if (node?.icon) return node.icon;
  if (node && isInquiry(node)) return 'message-square';
  if (node?.kind === 'branch') return 'git-branch';
  if (/银行|银企|划拨|调拨|中债/.test(node?.title ?? '')) return 'landmark';
  if (/等待/.test(node?.title ?? '')) return 'clock';
  if (/群|导出/.test(node?.title ?? '')) return 'send';
  return 'file-text';
}
