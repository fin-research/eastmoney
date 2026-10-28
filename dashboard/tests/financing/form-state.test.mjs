import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const mutationPages = [
	'src/routes/financing/projects/+page.svelte',
	'src/routes/financing/projects/[id]/+page.svelte',
	'src/routes/financing/sop/+page.svelte',
	'src/routes/financing/sop/[id]/+page.svelte'
];

const incrementalContracts = [
	{
		name: 'projects',
		server: 'src/routes/financing/projects/+page.server.ts',
		client: 'src/routes/financing/projects/+page.svelte',
		response: /project:\s*await getProjectSource\(projectId\)/,
		apply: /result\.data\?\.project/
	},
	{
		name: 'project detail',
		server: 'src/routes/financing/projects/[id]/+page.server.ts',
		client: 'src/routes/financing/projects/[id]/+page.svelte',
		response: /task:\s*after|task:\s*\{/,
		apply: /applyActionDelta\(result\.data\)/
	},
	{
		name: 'SOP management',
		server: 'src/routes/financing/sop/+page.server.ts',
		client: 'src/routes/financing/sop/+page.svelte',
		response: /sopTemplate:\s*\{/,
		apply: /result\.data\?\.sopTemplate/
	},
	{
		name: 'profile settings',
		server: 'src/routes/api/profile/+server.ts',
		client: 'src/routes/management/me/+page.svelte',
		response: /identityRequest/,
		apply: /result.name/
	}
];

test('route forms never use SvelteKit default form reset outside login', async () => {
	const routesDirectory = new URL('../../src/routes/financing/', import.meta.url);
	const routeFiles = (await readdir(routesDirectory, { recursive: true }))
		.map(String)
		.filter((file) => file.endsWith('+page.svelte') && file !== 'login/+page.svelte');
	for (const file of routeFiles) {
		const source = await readFile(new URL(file, routesDirectory), 'utf8');
		assert.doesNotMatch(
			source,
			/await\s+update\(\s*\)\s*;/,
			`src/routes/${file} must explicitly preserve form state instead of calling bare update()`
		);
	}
});

test('SOP and project detail edit forms explicitly preserve their controls', async () => {
	for (const file of [
		'src/routes/financing/projects/[id]/+page.svelte',
		'src/routes/financing/sop/[id]/+page.svelte'
	]) {
		const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
		assert.match(source, /update\(\{\s*reset:\s*false,/);
	}
});

test('mutation pages explicitly choose form reset and invalidation behavior', async () => {
	for (const file of mutationPages) {
		const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
		assert.match(source, /update\(\{\s*reset:/, `${file} must choose reset behavior explicitly`);
	}
});

test('mutation pages return and apply server-confirmed entity deltas', async () => {
	for (const contract of incrementalContracts) {
		const [serverSource, clientSource] = await Promise.all([
			readFile(new URL(`../../${contract.server}`, import.meta.url), 'utf8'),
			readFile(new URL(`../../${contract.client}`, import.meta.url), 'utf8')
		]);
		assert.match(serverSource, contract.response, `${contract.name} action must return a confirmed entity delta`);
		assert.match(clientSource, contract.apply, `${contract.name} page must apply action response data immediately`);
	}
});

test('mutation pages do not invalidate and refetch their full page data', async () => {
	for (const file of mutationPages) {
		const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
		assert.doesNotMatch(
			source,
			/invalidateAll:\s*(?:true|responseIsCurrent|result\.type)/,
			`${file} must keep successful mutations incremental`
		);
	}

	const sopDetail = await readFile(new URL('../../src/routes/financing/sop/[id]/+page.svelte', import.meta.url), 'utf8');
	assert.match(sopDetail, /if \(responseIsCurrent\) applyActionData\(result\.data\);\s*await update\(\{ reset: false, invalidateAll: false \}\);/);
});

test('only global identity or reminder data is invalidated after relevant deltas', async () => {
	const [layout, projects, projectDetail, people, settings] = await Promise.all([
		readFile(new URL('../../src/routes/financing/+layout.server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/projects/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/projects/[id]/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/management/ManagementPeopleView.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/management/me/+page.svelte', import.meta.url), 'utf8')
	]);
	assert.match(layout, /depends\('financing:identity', 'financing:permissions', 'financing:reminders'\)/);
	assert.match(projects, /invalidate\('financing:reminders'\)/);
	assert.match(projectDetail, /invalidate\('financing:reminders'\)/);
	assert.match(people, /invalidate\('auth:permissions'\)/);
	assert.match(settings, /result.name/);
	assert.doesNotMatch(people, /invalidateAll/);
});

test('role view delegates edits to Auth0 and only refreshes the Gateway cache', async () => {
  const [server, client] = await Promise.all([
    readFile(new URL('../../src/routes/management/people/+page.server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/lib/management/ManagementPeopleView.svelte', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(server, /export const actions|saveRolePermissions/);
  assert.match(server, /depends\('auth:permissions'\)/);
  assert.match(client, /manage.auth0.com/);
  assert.match(client, /auth\/permissions\/refresh/);
  assert.match(client, /PermissionExplorer/);
  assert.doesNotMatch(client, /drafts|saveRolePermissions/);
});

test('project and SOP edit forms auto-save without per-item save buttons', async () => {
	const [projects, projectDetail, sopDetail, autoSave] = await Promise.all([
		readFile(new URL('../../src/routes/financing/projects/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/projects/[id]/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/sop/[id]/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/auto-save.ts', import.meta.url), 'utf8')
	]);

	assert.match(projects, /action="\?\/updateProject" use:autoSave use:enhance=/);
	assert.match(projectDetail, /action=\{canManage \? '\?\/updateTask' : '\?\/updateOwnTaskStatus'\}[\s\S]*?use:autoSave=/);
	assert.match(projectDetail, /action="\?\/updateProject"[\s\S]*?use:autoSave=/);
	assert.match(sopDetail, /action="\?\/updateNode"[\s\S]*?use:autoSave/);
	assert.match(sopDetail, /action="\?\/updateTemplate" use:autoSave use:enhance=/);
	assert.doesNotMatch(projectDetail, /保存基本信息|>保存</);
	assert.doesNotMatch(sopDetail, /保存模板信息|class="save-button"/);
	assert.match(autoSave, /let inFlight = false/);
	assert.match(autoSave, /revisionOf\(form\) > submittedRevision/);
	assert.match(autoSave, /form\.requestSubmit\(\)/);
});

test('new financing projects use one bookbuilding date anchored to SOP issue day', async () => {
	const [page, server] = await Promise.all([
		readFile(new URL('../../src/routes/financing/projects/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/projects/+page.server.ts', import.meta.url), 'utf8')
	]);

	assert.doesNotMatch(page, /name="borrower"|name="startDate"|name="endDate"/);
	assert.match(page, /<span>计划簿记<\/span>\s*<Input[^>]*name="plannedBookbuildingDate" type="date"/);
	assert.match(server, /const plannedBookbuildingDate = projectBookbuildingDate\(data\)/);
	assert.match(server, /planned_start_date, planned_issue_date/);
	assert.match(server, /resolveSopSchedule\(plannedBookbuildingDate, node/);
	assert.match(server, /default_offset_days = 0/);
});

test('Data API mutations request returned rows and editors reuse one form', async () => {
 const [apiSource, editor] = await Promise.all([
  readFile(new URL('../../src/lib/financing/neon-data-api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/lib/financing/DebtDataEditor.svelte', import.meta.url), 'utf8')
 ]);
 assert.ok((apiSource.match(/Prefer: 'return=representation'/g) ?? []).length >= 3);
 assert.match(editor, /debtEditorPayload/);
 assert.match(editor, /api.insert/);
 assert.match(editor, /api.update/);
});
