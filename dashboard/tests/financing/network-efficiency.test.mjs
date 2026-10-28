import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('page data preloading uses tap globally and hover only for fixed navigation', async () => {
  const [app, shell, layout] = await Promise.all([
    readFile(new URL('../../src/app.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/lib/workbench/WorkbenchShell.svelte', import.meta.url), 'utf8'),
    readFile(new URL('../../src/routes/financing/+layout.svelte', import.meta.url), 'utf8')
  ]);
  assert.match(app, /data-sveltekit-preload-data="tap"/);
  assert.doesNotMatch(app, /data-sveltekit-preload-data="hover"/);
  assert.match(shell, /class="tr-drawer__nav"[^>]*data-sveltekit-preload-data="hover"/);
  assert.match(layout, /<WorkbenchShell/);
  assert.doesNotMatch(layout, /preloadData|data-sveltekit-preload-code="viewport"/);
});

test('slow navigations expose pending and accessible loading states', async () => {
	const [layout, styles] = await Promise.all([
		readFile(new URL('../../src/routes/financing/+layout.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/layout.css', import.meta.url), 'utf8')
	]);
	assert.match(layout, /import \{ navigating, page \} from '\$app\/state'/);
	assert.match(layout, /setTimeout\(\(\) => \(navigationSlow = true\), 300\)/);
	assert.match(layout, /<WorkbenchShell/);
	assert.match(layout, /role="progressbar" aria-label="页面加载中"/);
	assert.match(layout, /aria-busy=\{Boolean\(navigating\.to\)\}/);
	assert.match(styles, /\.navigation-progress::after/);
	assert.match(styles, /@keyframes navigation-progress/);
});

test('authenticated page loads do not transfer the base64 avatar through locals', async () => {
	const [auth, layout, avatar] = await Promise.all([
		readFile(new URL('../../src/lib/server/auth0-directory.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/+layout.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/avatar/+server.ts', import.meta.url), 'utf8')
	]);
	assert.doesNotMatch(auth, /avatar_data_url AS avatarDataUrl/);
	assert.match(auth, /identityJson<DirectoryPerson\[\]>/);
	assert.doesNotMatch(layout, /avatar_data_url|avatarVersion/);
	assert.match(avatar, /error\(410/);
});

test('reminder history is cursor-paginated in bounded batches', async () => {
	const [page, endpoint, query] = await Promise.all([
		readFile(new URL('../../src/routes/financing/sop/reminders/+page.server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/sop/reminders/more/+server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/server/financing/queries.js', import.meta.url), 'utf8')
	]);
	assert.match(page, /limit: 50/);
	assert.match(endpoint, /includeSummary: false/);
	assert.match(query, /nextCursor/);
	assert.match(query, /safeLimit \+ 1/);
});

test('authorization decisions are fresh while directory requests are reused only within one request', async () => {
 const [hooks, directory, authorization] = await Promise.all([
   readFile(new URL('../../src/hooks.server.ts', import.meta.url), 'utf8'),
   readFile(new URL('../../src/lib/server/auth0-directory.ts', import.meta.url), 'utf8'),
   readFile(new URL('../../src/lib/server/gateway-context.ts', import.meta.url), 'utf8')
 ]);
 assert.match(hooks, /gatewayContext/);
 assert.match(directory, /let people:/);
 assert.match(directory, /let roles:/);
 assert.match(authorization, /env\.GATEWAY_CONTEXT/);
 assert.doesNotMatch(authorization, /readCachedSessionUser|cacheSessionUser/);
 assert.match(hooks, /finally.*closeDatabase/);
});

test('page loads defer form-only options and remove duplicate identity queries', async () => {
	const [projectsPage, projectOptions, projectComponent, settingsPage, settingsComponent, sopDetail] = await Promise.all([
		readFile(new URL('../../src/routes/financing/projects/+page.server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/projects/options/+server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/projects/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/management/financing-profile/+page.server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/management/me/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/sop/[id]/+page.server.ts', import.meta.url), 'utf8')
	]);
	assert.doesNotMatch(projectsPage, /getProjectFormOptions|getActiveProjectSopOptions/);
	assert.match(projectOptions, /getProjectFormOptions/);
	assert.match(projectComponent, /fetch\(withBase\('\/projects\/options'\)/);
	assert.match(settingsPage, /redirect\(303, '\/management\/me'\)/);
	assert.match(settingsComponent, /profile\.name/);
	assert.match(sopDetail, /async function loadSopDetail/);
	assert.match(sopDetail, /jsonb_agg\(jsonb_build_object/);
});

test('data administration gets its endpoint with the private token request', async () => {
	const [endpoint, client, page, table, importer, parameters] = await Promise.all([
		readFile(new URL('../../src/routes/financing/data/token/+server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/neon-data-api.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/routes/financing/data/+page.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/DataAdminTable.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/DebtImportPanel.svelte', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/FinanceParametersPanel.svelte', import.meta.url), 'utf8')
	]);
	await assert.rejects(
		readFile(new URL('../../src/routes/financing/data/+page.server.ts', import.meta.url), 'utf8'),
		(error) => error?.code === 'ENOENT'
	);
	assert.match(endpoint, /transport: 'worker', dataApiUrl:/);
	assert.match(endpoint, /'cache-control': 'no-store, private'/);
	assert.match(endpoint, /vary: 'Cookie'/);
	assert.match(client, /dataApiUrl\?: string/);
	assert.match(client, /parsed\.protocol !== 'https:'/);
	assert.match(page, /<DataAdminTable config=\{entity\}/);
	assert.match(page, /<FinanceParametersPanel permissions=\{permissions\} \/>/);
	assert.match(parameters, /new NeonDataApi\(\)/);
	assert.doesNotMatch(parameters.slice(parameters.indexOf('async function save()')), /api\.list\(|loadRows\(\);|invalidateAll/);
	assert.match(page, /hasPermission\(permissions, 'financing.data:read'\)/);
	assert.match(page, /<DebtImportPanel \/>/);
	assert.match(table, /new NeonDataApi\(\)/);
	assert.doesNotMatch(page, /dataApiUrl/);
	assert.match(importer, /fetch\(withBase\('\/data\/import'\)/);
	// Increment selection and JSON request failures are covered by debt-import tests.
});

test('liability report page reads one snapshot and generation splits business and raw market Data API reads', async () => {
	const [page, service, client, layout] = await Promise.all([
		readFile(new URL('../../src/routes/financing/liability-report/+page.server.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/server/financing/liability-weekly-reports.js', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/neon-data-api.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../src/lib/financing/LiabilityReportActions.svelte', import.meta.url), 'utf8')
	]);
	assert.match(page, /getLiabilityWeeklyReportRunByDate\(database, selectedReportDate\)/);
	assert.match(page, /if \(selectedRun && platform\?\.env\?\.LIABILITY_REPORT_SNAPSHOTS\)/);
	assert.doesNotMatch(page, /getLiabilityWeeklyReportData|fetchManualLiabilitySources|liabilityWeeklyReport\(/);
	assert.equal((service.match(/database\.prepare\(/g) ?? []).length, 3);
	assert.match(service, /WHERE as_of_date = \? AND status = 'complete'[\s\S]*updated_at <= CURRENT_TIMESTAMP/);
	assert.match(client, /#request\('rpc\/liability_weekly_report_data'/);
	assert.match(client, /#request\(`liability_market_rate_observations\?\$\{params\}`\)/);
	assert.match(layout, /const neonDataApi = new NeonDataApi\(\)/);
	assert.match(layout, /const marketRatesRequest = neonDataApi\.liabilityMarketRates\(asOfDate\)\.then\(/);
	assert.match(layout, /Promise\.all\(\[[\s\S]*fetchManualLiabilitySources[\s\S]*liabilityWeeklyReportBusiness[\s\S]*marketRatesRequest/);
	assert.match(layout, /attachLiabilityMarketRates\([\s\S]*marketRatesResult\.rows,[\s\S]*marketRatesResult\.error/);
	assert.match(layout, /await update\(\{ reset: false, invalidateAll: false \}\)/);
	assert.match(page, /snapshotVersion: report \? selectedRun\?\.contentSha256 \?\? null : null/);
	assert.match(layout, /await goto\(reportUrl, \{[\s\S]*invalidateAll: true[\s\S]*replaceState: true[\s\S]*noScroll: true/);
	assert.match(layout, /page\.data as any\)\?\.snapshotVersion[\s\S]*window\.location\.replace\(reportUrl\)/);
	assert.match(layout, /sessionStorage\.setItem\(REPORT_NOTICE_KEY/);
});
