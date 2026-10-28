import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mutationSurfaces = [
	'src/lib/management/ManagementPeopleView.svelte',
	'src/routes/financing/projects/+page.svelte',
	'src/routes/financing/projects/[id]/+page.svelte',
	'src/routes/management/me/+page.svelte',
	'src/routes/financing/sop/+page.svelte',
	'src/routes/financing/sop/[id]/+page.svelte',
	'src/routes/financing/sop/reminders/+page.svelte',
	'src/lib/financing/DataAdminTable.svelte'
];

test('mutation feedback uses the global surface instead of page-flow banners', async () => {
	for (const file of mutationSurfaces) {
		const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
		assert.match(source, /globalMessages\.(?:success|error|warning|info)\(/, `${file} must publish global messages`);
		assert.doesNotMatch(source, /action-feedback|form-feedback|table-feedback|class="feedback/, `${file} must not render an inline system-message banner`);
	}
});
