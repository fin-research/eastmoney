import type { WorkbenchIconName } from '../trading-research/demo-data';

/** 一级板块、二级页面、三级标签页均以真实 href 为入口。 */
export type PageLink = { label: string; href: string };
export type PageTab = PageLink & { id: string };
export type WorkbenchPageLink = PageTab & {
  icon: WorkbenchIconName;
  permission?: string;
  separatorBefore?: boolean;
};

export const managementViews: readonly WorkbenchPageLink[] = [
  { id: 'me', label: '我的', href: '/management/me', icon: 'user' },
  { id: 'permissions', label: '权限', href: '/management/permissions', icon: 'credit' },
  { id: 'notifications', label: '通知', href: '/management/notifications', icon: 'file' },
  { id: 'messenger', label: '通知管理', href: '/management/messenger', icon: 'file', permission: 'admin', separatorBefore: true },
  { id: 'people', label: '人员与角色', href: '/management/people', icon: 'credit', permission: 'admin' },
  { id: 'fund-report', label: '资金日报', href: '/fund-report?upload=1', icon: 'file', permission: 'admin' },
];

export const notificationTabs: readonly PageTab[] = [
  { id: 'delivery', label: '消息投递', href: '/management/messenger?tab=delivery' },
  { id: 'test', label: '测试消息', href: '/management/messenger?tab=test' },
];
export const managementPeopleTabs: readonly PageTab[] = [
  { id: 'people', label: '人员', href: '/management/people?tab=people' },
  { id: 'roles', label: '角色', href: '/management/people?tab=roles' },
];
export function managementPeopleTab(value: string | null): 'people' | 'roles' {
  return value === 'roles' ? 'roles' : 'people';
}
export function notificationTab(value: string | null): 'delivery' | 'test' {
  return value === 'test' ? 'test' : 'delivery';
}
