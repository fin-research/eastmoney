import { financingPersonView } from '$lib/identity';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/financing/db.js';
import { fail } from '@sveltejs/kit';
import {
	getLiabilityWeeklyReportRunByDate,
	readLiabilityWeeklyReportSnapshot,
	saveLiabilityWeeklyReportSnapshot
} from '$lib/server/financing/liability-weekly-reports.js';

const MAX_SOURCE_PAYLOAD_LENGTH = 4_000_000;

function dateInShanghai() {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
	}).format(new Date());
}

export const load: PageServerLoad = async ({ url, platform }) => {
	const database = getDatabase();
	const today = dateInShanghai();
	const requestedDate = String(url.searchParams.get('date') ?? '');
	const selectedReportDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && requestedDate <= today
		? requestedDate
		: today;
	const selectedRun = await getLiabilityWeeklyReportRunByDate(database, selectedReportDate);
	let report: any = null;
	let snapshotError: string | null = null;
	if (selectedRun && platform?.env?.LIABILITY_REPORT_SNAPSHOTS) {
		try {
			const snapshot = await readLiabilityWeeklyReportSnapshot(platform.env, selectedRun);
			report = { ...snapshot.report, provenance: snapshot.provenance };
		} catch (error: any) {
			snapshotError = String(error?.message ?? error);
		}
	}
	const configuredDataApiUrl = platform?.env?.CHOICE_DATA_API_URL;
	const externalDataApiUrl = String(configuredDataApiUrl || new URL('/data', url.origin))
		.replace(/\/$/, '');
	return {
		report,
		selectedReportDate,
		today,
		hasSnapshot: Boolean(report),
		snapshotVersion: report ? selectedRun?.contentSha256 ?? null : null,
		snapshotError,
		externalDataApiUrl
	};
};

export const actions = {
	saveSnapshot: async (event) => {
		const data = await event.request.formData();
		const sourcesPayload = String(data.get('payload') ?? '');
		if (!sourcesPayload || sourcesPayload.length > MAX_SOURCE_PAYLOAD_LENGTH) {
			return fail(400, { message: '周报数据源为空或超过快照大小限制' });
		}
			let payload;
			try {
				payload = JSON.parse(sourcesPayload);
		} catch {
			return fail(400, { message: '周报数据源格式无效' });
		}
		try {
			const result = await saveLiabilityWeeklyReportSnapshot({
				database: getDatabase(event),
				env: event.platform?.env,
				actor: financingPersonView(event.locals.user),
					databasePayload: payload.database,
					sources: payload.external,
				expectedAsOfDate: String(data.get('asOfDate') ?? '')
			});
			return {
				success: true,
				reportRunId: result.id,
				snapshotVersion: result.contentSha256,
				missingModules: result.missingModules,
				message: `已生成 ${result.asOfDate} 周报快照`
			};
		} catch (error: any) {
			return fail(503, { message: `周报快照保存失败：${String(error?.message ?? error)}` });
		}
	}
};
