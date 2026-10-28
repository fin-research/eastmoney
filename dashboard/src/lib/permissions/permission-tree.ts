import { PERMISSION_DEFINITIONS, PERMISSION_DOMAINS } from '../permissions.ts';

export const ACTION_LABELS: Record<string, string> = {
  read: '查看', create: '新增', update: '修改', delete: '删除', import: '导入', upload: '上传',
  generate: '生成', ask: '提问', update_own: '办理本人任务',
};
export function permissionTree(granted: readonly string[], query = '', grantedOnly = false) {
  const allowed = new Set(granted);
  const search = query.trim().toLowerCase();
  return Object.entries(PERMISSION_DOMAINS).map(([scope, label]) => {
    const resources = new Map<string, { id: string; name: string; actions: { code: string; action: string; name: string; description: string; granted: boolean }[] }>();
    for (const [code, name, description] of PERMISSION_DEFINITIONS) {
      const [path, action] = code.split(':') as [string, string];
      if (!path.startsWith(scope + '.')) continue;
      const id = path.slice(scope.length + 1);
      const resource = resources.get(id) ?? { id, name, actions: [] };
      if (action === 'read') resource.name = name;
      resources.set(id, resource);
      resource.actions.push({ code, action, name: ACTION_LABELS[action] ?? action, description, granted: allowed.has(code) });
    }
    return { scope, label, resources: [...resources.values()].map(resource => ({ ...resource,
      actions: resource.actions.filter(action => (!grantedOnly || action.granted)
        && (!search || `${label} ${scope} ${resource.name} ${resource.id} ${action.name} ${action.code} ${action.description}`.toLowerCase().includes(search))),
    })).filter(resource => resource.actions.length) };
  }).filter(group => group.resources.length);
}

const ROLE_LABELS: Record<string, string> = {
  authenticated: '基础用户', financing: '融资组', 'financing:admin': '融资管理员',
  'financing:handler': '融资经办', 'financing:reviewer': '融资复核',
};
export function roleLabel(name: string) { return ROLE_LABELS[name] ?? name; }
