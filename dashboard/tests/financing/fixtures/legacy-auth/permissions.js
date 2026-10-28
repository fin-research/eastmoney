// Historical pre-0032 authentication fixture; never imported by production code.
export const PERMISSION_DEFINITIONS = [
	{
		code: 'project_manage',
		label: '项目管理',
		description: '新建、编辑和删除融资项目及任务节点'
	},
	{
		code: 'own_task_update',
		label: '本人任务办理',
		description: '更新分配给本人的任务节点状态'
	},
	{
		code: 'sop_manage',
		label: 'SOP 与提醒',
		description: '维护 SOP 模板、节点和邮件提醒规则'
	},
	{
		code: 'people_manage',
		label: '人员与账号',
		description: '维护人员主档、角色和登录账号'
	},
	{
		code: 'data_manage',
		label: '数据后台',
		description: '编辑业务数据并导入借入资金台账'
	},
	{
		code: 'report_generate',
		label: '周报生成',
		description: '拉取数据并生成或覆盖负债周报快照'
	},
	{
		code: 'permission_manage',
		label: '权限配置',
		description: '调整各业务角色的权限类型'
	}
];

export const PERMISSION_CODES = PERMISSION_DEFINITIONS.map(({ code }) => code);
const PERMISSION_CODE_SET = new Set(PERMISSION_CODES);

const ALWAYS_ALLOWED_MUTATIONS = new Set([
	'/logout:default',
	'/settings:updateProfile',
	'/settings:updatePassword'
]);

const MUTATION_PERMISSIONS = new Map([
	['/people:createPerson', 'people_manage'],
	['/people:updatePerson', 'people_manage'],
	['/people:togglePerson', 'people_manage'],
	['/people:deletePerson', 'people_manage'],
	['/people:saveRolePermissions', 'permission_manage'],
	['/projects:createProject', 'project_manage'],
	['/projects:updateProject', 'project_manage'],
	['/projects:deleteProject', 'project_manage'],
	['/projects/[id]:updateProject', 'project_manage'],
	['/projects/[id]:updateTask', 'project_manage'],
	['/projects/[id]:addTask', 'project_manage'],
	['/projects/[id]:updateOwnTaskStatus', 'own_task_update'],
	['/sop:createReminder', 'sop_manage'],
	['/sop:createSop', 'sop_manage'],
	['/sop/[id]:updateTemplate', 'sop_manage'],
	['/sop/[id]:toggleTemplate', 'sop_manage'],
	['/sop/[id]:addNode', 'sop_manage'],
	['/sop/[id]:updateNode', 'sop_manage'],
	['/sop/[id]:reorderNodes', 'sop_manage'],
	['/sop/[id]:deleteNode', 'sop_manage'],
	['/liability-report:saveSnapshot', 'report_generate'],
	['/data/import:default', 'data_manage']
	, ['/data/api/[...path]:default', 'data_manage']
]);

/** @param {unknown} code */
export function isPermissionCode(code) {
	return typeof code === 'string' && PERMISSION_CODE_SET.has(code);
}

/** @param {string[] | null | undefined} permissions @param {string} code */
export function hasPermission(permissions, code) {
	return isPermissionCode(code) && Array.isArray(permissions) && permissions.includes(code);
}

/**
 * @param {string[] | null | undefined} permissions
 * @param {string | null} routeId
 * @param {string} method
 * @param {string} actionName
 */
export function isPermissionAuthorizedRequest(permissions, routeId, method, actionName = 'default') {
	if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
	const actionKey = `${routeId ?? ''}:${actionName}`;
	if (ALWAYS_ALLOWED_MUTATIONS.has(actionKey)) return true;
	const permission = MUTATION_PERMISSIONS.get(actionKey);
	return permission ? hasPermission(permissions, permission) : false;
}
