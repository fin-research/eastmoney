<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
import { enhance } from '$app/forms';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { tick } from 'svelte';
import { LoaderCircle, Printer } from '@lucide/svelte';
import { withBase } from '$lib/financing/app-paths';
import { fetchManualLiabilitySources } from '$lib/financing/liability-choice.js';
import { attachLiabilityMarketRates } from '$lib/financing/liability-report-data.js';
import { NeonDataApi } from '$lib/financing/neon-data-api';
import { hasPermission } from '$lib/permissions';
import { globalMessages } from '$lib/global-messages';
let { permissions }: { permissions: string[] } = $props();
	let reportGenerating = $state(false);
	let reportSnapshotForm = $state<HTMLFormElement>();
	let reportSourcesPayload = $state('');
	let restoredReportNotice = false;
	const REPORT_NOTICE_KEY = 'financing:liability-report-generation-notice';
	type ReportGenerationNotice = { message: string; missingModules: Array<{ title: string; detail: string }> };

	const reportGenerationNotice = (resultData: any): ReportGenerationNotice => ({
		message: String(resultData?.message ?? '周报已生成'),
		missingModules: Array.isArray(resultData?.missingModules) ? resultData.missingModules : []
	});
	const publishReportGenerationNotice = (notice: ReportGenerationNotice) => {
		globalMessages.success(notice.message, {
			key: 'liability-report-generation',
			title: '周报生成完成'
		});
		if (notice.missingModules.length > 0) {
			globalMessages.warning(
				notice.missingModules.map((item) => `${item.title}：${item.detail}`).join('；'),
				{
					key: 'liability-report-missing-modules',
					title: `本次周报有 ${notice.missingModules.length} 项待核对`,
					duration: 12000
				}
			);
		}
	};
	const preserveReportGenerationNotice = (notice: ReportGenerationNotice) => {
		try {
			sessionStorage.setItem(REPORT_NOTICE_KEY, JSON.stringify(notice));
		} catch {
			// A hard reload still refreshes the report when session storage is unavailable.
		}
	};
	$effect(() => {
		if (restoredReportNotice) return;
		restoredReportNotice = true;
		try {
			const raw = sessionStorage.getItem(REPORT_NOTICE_KEY);
			if (!raw) return;
			sessionStorage.removeItem(REPORT_NOTICE_KEY);
			publishReportGenerationNotice(JSON.parse(raw));
		} catch {
			// The report remains usable when storage is unavailable or contains invalid data.
		}
	});
	const selectedLiabilityReportDate = () => String((page.data as any)?.selectedReportDate ?? '');
	const submitReportHistorySelection = (event: Event) => {
		(event.currentTarget as HTMLInputElement).form?.requestSubmit();
	};
	const prepareReportSnapshot = async () => {
		if (reportGenerating) return;
		reportGenerating = true;
		try {
			const asOfDate = selectedLiabilityReportDate();
			const externalDataApiUrl = String((page.data as any)?.externalDataApiUrl ?? new URL('/data', window.location.origin));
			const neonDataApi = new NeonDataApi();
			const marketRatesRequest = neonDataApi.liabilityMarketRates(asOfDate).then(
				(rows) => ({ rows, error: null }),
				(error) => ({
					rows: [],
					error: String(error?.message ?? error).slice(0, 500)
				})
			);
			const [external, business, marketRatesResult] = await Promise.all([
				fetchManualLiabilitySources({ dataApiUrl: externalDataApiUrl, asOfDate }),
				neonDataApi.liabilityWeeklyReportBusiness(asOfDate),
				marketRatesRequest
			]);
			const database = attachLiabilityMarketRates(
				business,
				marketRatesResult.rows,
				asOfDate,
				marketRatesResult.error
			);
			reportSourcesPayload = JSON.stringify({ external, database });
			await tick();
			if (!reportSnapshotForm) throw new Error('周报快照表单尚未就绪');
			reportSnapshotForm.requestSubmit();
		} catch (error: any) {
			globalMessages.error(`周报生成失败：${String(error?.message ?? error)}`, {
				key: 'liability-report-generation'
			});
			reportGenerating = false;
		}
	};
	const enhanceReportSnapshotSaving = () => {
		return async ({ result, update }: any) => {
			try {
				await update({ reset: false, invalidateAll: false });
				if (result.type === 'success') {
					const notice = reportGenerationNotice(result.data);
					const reportDate = selectedLiabilityReportDate();
					const reportUrl = withBase(`/liability-report?date=${encodeURIComponent(reportDate)}`);
					const expectedVersion = String(result.data?.snapshotVersion ?? '');
					try {
						await goto(reportUrl, {
							invalidateAll: true,
							replaceState: true,
							noScroll: true,
							keepFocus: true
						});
						await tick();
						if (!expectedVersion || String((page.data as any)?.snapshotVersion ?? '') !== expectedVersion) {
							preserveReportGenerationNotice(notice);
							window.location.replace(reportUrl);
							return;
						}
					} catch {
						preserveReportGenerationNotice(notice);
						window.location.replace(reportUrl);
						return;
					}
					publishReportGenerationNotice(notice);
				} else {
					const message = result.type === 'failure'
						? String(result.data?.message ?? '周报生成失败，请检查后重试。')
						: result.type === 'error' && result.error?.message
							? result.error.message
							: '周报生成失败，请稍后重试。';
					globalMessages.error(message, { key: 'liability-report-generation' });
				}
			} finally {
				reportSourcesPayload = '';
				reportGenerating = false;
			}
		};
	};
</script>
<div>
					<div class="report-header-actions" aria-label="负债周报操作">
						<form class="report-history-picker" method="GET" action={withBase('/liability-report')}>
							<label for="report-history-date">报告日</label>
							<Input data-ui-owner="lib-financing-LiabilityReportActions-svelte" class={"ui-input"}
								type="date"
								id="report-history-date"
								name="date"
								value={selectedLiabilityReportDate()}
								max={String((page.data as any)?.today ?? '')}
								onchange={submitReportHistorySelection}
							/>
						</form>
						<Button data-ui-owner="lib-financing-LiabilityReportActions-svelte" variant="outline" class={"ui-button header-action"} type="button" disabled={!Boolean((page.data as any)?.hasSnapshot)} onclick={() => window.print()} aria-label="导出 PDF">
							<Printer size={17} /><span class="header-action-label">导出 PDF</span>
						</Button>
						{#if hasPermission(permissions, 'financing.report:generate')}
							<form bind:this={reportSnapshotForm} method="POST" action={withBase('/liability-report?/saveSnapshot')} use:enhance={enhanceReportSnapshotSaving}>
								<input data-ui-owner="lib-financing-LiabilityReportActions-svelte" type="hidden" name="asOfDate" value={selectedLiabilityReportDate()} />
								<input data-ui-owner="lib-financing-LiabilityReportActions-svelte" type="hidden" name="payload" value={reportSourcesPayload} />
								<Button data-ui-owner="lib-financing-LiabilityReportActions-svelte" variant="default" class={"ui-button  header-action header-primary-action"} type="button" disabled={reportGenerating} onclick={prepareReportSnapshot} aria-label={reportGenerating ? '正在生成本期周报' : '生成本期周报'}>
									<LoaderCircle class={reportGenerating ? 'spinning' : ''} size={17} />
									<span>{reportGenerating ? '生成中…' : '生成本期周报'}</span>
								</Button>
							</form>
						{/if}
					</div>
</div>
