<script lang="ts">
import { getContext } from 'svelte';
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
	import './weekly-report.css';
	import { withBase } from '$lib/financing/app-paths';
	import { FileText } from '@lucide/svelte';
	import { liabilityTypeColor } from '../../../charts/financing/report';
	import { emptyLiabilityWeeklyReport } from '$lib/financing/liability-report-data.js';
	import { hasPermission } from '$lib/permissions';
	import ReportBalanceRateChart from '../../../charts/financing/ReportBalanceRateChart.svelte';
	import ReportDonutChart from '../../../charts/financing/ReportDonutChart.svelte';
	import ReportGaugeChart from '../../../charts/financing/ReportGaugeChart.svelte';
	import ReportIssuanceChart from '../../../charts/financing/ReportIssuanceChart.svelte';
	import ReportLineChart from '../../../charts/financing/ReportLineChart.svelte';
	import ReportProgressChart from '../../../charts/financing/ReportProgressChart.svelte';
	import ReportStackedBarChart from '../../../charts/financing/ReportStackedBarChart.svelte';

	let { data } = $props();
	const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
	const permissions = $derived($session?.permissions ?? data.permissions);
	let report = $derived(data.report ?? emptyLiabilityWeeklyReport(data.selectedReportDate));
	let hasSnapshot = $derived(Boolean(data.hasSnapshot));
	let canGenerate = $derived(hasPermission(permissions, 'financing.report:generate'));
	let currentEvents = $derived((report?.events ?? []).filter((item: any) => item.week === 'current' && isDynamicEvent(item)));
	let nextEvents = $derived((report?.events ?? []).filter((item: any) => item.week === 'next' && isDynamicEvent(item)));
	let dynamicProjects = $derived((report?.projects ?? []).filter((item: any) => !['同业拆借', '浮动收益凭证'].includes(String(item.debtType ?? ''))));
	let compositionTotal = $derived((report?.composition ?? []).reduce((sum: number, item: any) => sum + Number(item.amountYi ?? 0), 0));
	let maturityLabels = $derived((report?.maturityDistribution ?? []).map((item: any) => item.month));
	let maturityTypes = $derived(orderedTypes(report?.maturityByType ?? []));
	let maturityRows = $derived((report?.maturityByType ?? []).map((item: any) => ({ label: item.month, type: item.type, value: Number(item.amountYi ?? 0) })));
	let annualLabels = $derived([...new Set((report?.annualMaturity ?? []).map((item: any) => item.bucket))] as string[]);
	let annualTypes = $derived(orderedTypes(report?.annualMaturity ?? []));
	let annualRows = $derived((report?.annualMaturity ?? []).map((item: any) => ({ label: item.bucket, type: item.type, value: Number(item.amountYi ?? 0) })));
	let peerRows = $derived(normalizePeerRows(report?.peerIssueSummary ?? []));
	let peerLabels = $derived(peerIssuerLabels(peerRows));
	let peerTypes = $derived(orderedPeerTypes(peerRows));
	let peerRegistrationColumns = $derived(splitPeerRegistrations(report?.registrationProgress ?? [], report?.peerIssuances?.length ?? 0));
	const marketCategories = [
		{ key: 'state_owned_bank_ncd', title: '国有行同业存单发行利率走势' },
		{ key: 'credit_spread_broker_govt_1y', title: 'AAA-券商与国债到期收益率及利差（1年）' },
		{ key: 'credit_spread_broker_govt_3y', title: 'AAA-券商与国债到期收益率及利差（3年）' },
		{ key: 'credit_spread_broker_govt_5y', title: 'AAA-券商与国债到期收益率及利差（5年）' }
	];

	function orderedTypes(rows: any[]) {
		const compositionOrder = (report?.composition ?? []).map((item: any) => item.type);
		return [...new Set(rows.map((item: any) => String(item.type)))].sort((a, b) => {
			const left = compositionOrder.indexOf(a);
			const right = compositionOrder.indexOf(b);
			return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.localeCompare(b, 'zh-CN');
		});
	}

	function isDynamicEvent(item: any) {
		return !['同业拆借', '浮动收益凭证'].includes(String(item.debtType ?? ''));
	}

	function orderedPeerTypes(rows: any[]) {
		const preferred = ['公募债', '次级债', '短期公司债', '短期融资券'];
		return [...new Set(rows.map((item: any) => String(item.type)))].sort((a, b) => {
			const left = preferred.indexOf(a);
			const right = preferred.indexOf(b);
			return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.localeCompare(b, 'zh-CN');
		});
	}

	function peerIssuerLabels(rows: any[]) {
		const totals = new Map<string, number>();
		for (const row of rows) {
			totals.set(row.label, (totals.get(row.label) ?? 0) + Number(row.value ?? 0));
		}
		return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
	}

	function normalizePeerRows(rows: any[]) {
		const totals = new Map<string, { label: string; type: string; value: number }>();
		for (const row of rows) {
			const label = brokerShortName(row.issuerName);
			const type = String(row.bondType ?? '其他');
			const key = `${label}\u0000${type}`;
			const current = totals.get(key) ?? { label, type, value: 0 };
			current.value += Number(row.amountYi ?? 0);
			totals.set(key, current);
		}
		return [...totals.values()];
	}

	function splitPeerRegistrations(rows: any[], pricingCount: number) {
		if (rows.length <= 10) return [rows, []];
		const leftCount = Math.max(1, Math.min(rows.length - 1, Math.ceil((rows.length - pricingCount - 2) / 2)));
		return [rows.slice(0, leftCount), rows.slice(leftCount)];
	}

	function brokerShortName(value: string | null | undefined) {
		if (!value) return '数据缺失';
		const legalName = String(value).trim().replace(/(?:股份有限公司|有限责任公司|有限公司)$/u, '');
		const aliases: Record<string, string> = {
			东方财富证券: '东方财富',
			国泰海通证券: '国泰海通',
			中国银河证券: '中国银河',
			中信建投证券: '中信建投',
			申万宏源证券: '申万宏源',
			中国国际金融: '中金公司'
		};
		return (aliases[legalName] ?? legalName) || '数据缺失';
	}

	function sumEvents(items: any[], kinds: string[]) { return hasSnapshot ? items.reduce((sum, item) => kinds.includes(item.kind) ? sum + Number(item.amountYi ?? 0) : sum, 0) : null; }
	function amount(value: number | null | undefined, digits = 2) { return value == null || !Number.isFinite(Number(value)) ? '数据缺失' : new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value)); }
	function numberOrDash(value: number | null | undefined, digits = 2) { return value == null || !Number.isFinite(Number(value)) ? '—' : amount(value, digits); }
	function percent(value: number | null | undefined, digits = 1) { return value == null || !Number.isFinite(Number(value)) ? '数据缺失' : `${amount(Number(value), digits)}%`; }
	function signed(value: number | null | undefined, digits = 2) { if (value == null || !Number.isFinite(Number(value))) return '数据缺失'; return `${Number(value) >= 0 ? '+' : '-'}${amount(Math.abs(Number(value)), digits)}`; }
	function dateLabel(value: string | null | undefined) { return value ? String(value).slice(0, 10).replaceAll('-', '/') : '数据缺失'; }
	function isoDate(value: string | null | undefined) { return value ? String(value).slice(0, 10) : '数据缺失'; }
	function addDays(value: string | null | undefined, days: number) { if (!value) return null; const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
	function yearEnd(value: string | null | undefined) { return value ? `${String(value).slice(0, 4)}-12-31` : null; }
	function share(value: number | null | undefined, total: number | null | undefined) { return total && Number.isFinite(Number(value)) ? percent(Number(value) / Number(total) * 100, 1) : '数据缺失'; }
	function headerDate(value: string | null | undefined) { if (!value) return '数据缺失'; const [year, month, day] = String(value).slice(0, 10).split('-'); return `${year}年${month}月${day}日`; }
	function weekdayDate(value: string | null | undefined) { if (!value) return '日期缺失'; const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`); return `周${'日一二三四五六'[date.getUTCDay()]} ${String(value).slice(5, 10)}`; }
	function eventLabel(kind: string) { return ({ maturity: '到期', interest: '付息', issue: '发行' } as Record<string, string>)[kind] ?? kind; }
	function projectRate(project: any) { if (project.expectedRateMin == null || project.expectedRateMax == null) return '数据缺失'; const min = amount(Number(project.expectedRateMin) * 100, 2); const max = amount(Number(project.expectedRateMax) * 100, 2); const interval = min === max ? `${min}%` : `${min}%–${max}%`; return project.fundingCostRate == null ? interval : `${interval}（资金成本 ${amount(Number(project.fundingCostRate) * 100, 2)}%）`; }
	function quotaPercent(issued: number | null | undefined, limit: number | null | undefined) { return limit ? Number(issued ?? 0) / Number(limit) * 100 : null; }
	function approvalRule(item: any) {
		if (item.calculationMode === 'net_capital_60') return '按上月末净资本×60%';
		if (!item.approvedDate) return '数据缺失';
		return `${dateLabel(item.approvedDate)}${item.expiryDate ? `–${dateLabel(item.expiryDate)}` : ''}`;
	}
	function marketRows(category: string) { return (report.marketHistory ?? []).filter((item: any) => item.category === category); }
	function gaugeState(value: number | null | undefined, warning: number, limit: number) {
		if (value == null || !Number.isFinite(Number(value))) return { key: 'missing', label: '待配置' };
		if (Number(value) >= limit) return { key: 'danger', label: '超上限' };
		if (Number(value) >= warning) return { key: 'warning', label: '需关注' };
		return { key: 'safe', label: '安全' };
	}
</script>

{#snippet peerPricingTable(rows: any[])}
	<div class="table-scroll"><table class="bento-table peer-pricing-table"><thead><tr><th>发行人</th><th>品种</th><th class="num">规模</th><th>期限</th><th class="num">利率</th><th>发行日期</th></tr></thead><tbody>{#each rows as item}<tr><td>{brokerShortName(item.issuerName)}</td><td>{item.bondType ?? '数据缺失'}</td><td class="num">{item.actualIssueAmountYi == null ? '数据缺失' : `${amount(item.actualIssueAmountYi)}亿`}</td><td>{item.issueTenor ?? '数据缺失'}</td><td class="num">{item.couponRatePct == null ? '数据缺失' : `${amount(item.couponRatePct, 2)}%`}</td><td>{dateLabel(item.issueDate)}</td></tr>{:else}<tr><td colspan="6" class="table-empty">可比券商发行数据缺失</td></tr>{/each}</tbody></table></div>
{/snippet}

{#snippet peerRegistrationTable(rows: any[])}
	<div class="table-scroll"><table class="bento-table registration-table"><thead><tr><th>发行方</th><th>品种</th><th class="num">申报</th><th>状态</th><th>更新日</th></tr></thead><tbody>{#each rows as item}<tr><td>{brokerShortName(item.issuerName)}</td><td>{item.variety ?? '数据缺失'}</td><td class="num">{item.amountYi == null ? '数据缺失' : `${amount(item.amountYi, 0)}亿`}</td><td><span class="status-badge status-green">{item.status ?? '数据缺失'}</span></td><td>{dateLabel(item.updateDate)}</td></tr>{:else}<tr><td colspan="5" class="table-empty">可比券商申报数据缺失</td></tr>{/each}</tbody></table></div>
{/snippet}

<svelte:head><title>东方财富证券 · 资金管理部负债周报</title></svelte:head>

{#if !hasSnapshot}
	<section class="report-empty" aria-labelledby="report-empty-title">
		<span class="report-empty-icon" aria-hidden="true"><FileText size={34} strokeWidth={1.7} /></span>
		<h1 id="report-empty-title">暂无 {data.selectedReportDate} 负债周报</h1>
		{#if data.snapshotError}
			<p role="alert">周报快照读取失败：{data.snapshotError}</p>
		{/if}
		{#if !canGenerate}<p>无周报生成权限</p>{/if}
	</section>
{:else}
{#key data.snapshotVersion}
<div class="report-pages">
	<article class="report-page">
		<div class="report-page-body">
			<header class="bento-header">
				<h1>东方财富证券 · 资金管理部负债周报</h1>
				<div class="report-period"><span>报表日期：{headerDate(report.asOfDate)}</span><span>编制：资金管理部 融资组</span></div>
			</header>

	<section class="report-section" aria-labelledby="section-1-title">
	<div class="card-head"><div class="section-title-wrap"><span class="section-tag">第一部分</span><h2 id="section-1-title" class="section-title">近期负债发行与到期动态</h2></div></div>
	<div class="bento-card dynamic-card"><div class="dynamic-grid">{#each [{ label: '本周', items: currentEvents, issueLabel: '负债缴款' }, { label: '下周', items: nextEvents, issueLabel: '负债发行' }] as group}<div class="template-week-card"><div class="week-summary">{group.label}{group.issueLabel} <strong class="positive">{amount(sumEvents(group.items, ['issue']))}</strong> 亿元，到期 <strong class="negative-text">{amount(sumEvents(group.items, ['maturity']))}</strong> 亿元，付息 <strong class="negative-text">{amount(sumEvents(group.items, ['interest']))}</strong> 亿元</div><div class="table-scroll"><table class="event-table"><tbody>{#each group.items as item}<tr><td>{weekdayDate(item.date)}</td><td><span class={`event-kind event-${item.kind}`}>{eventLabel(item.kind)}</span>：【{item.name}】</td><td>{amount(item.amountYi, 4)}E</td></tr>{:else}<tr><td colspan="3" class="table-empty">{hasSnapshot ? '暂无动态' : '暂无可靠数据'}</td></tr>{/each}</tbody></table></div></div>{/each}</div><div class="template-plan-card"><div class="plan-title">推进中的融资计划</div><div class="table-scroll"><table class="plan-table"><thead><tr><th>品种</th><th>规模</th><th>期限</th><th>预计利率区间</th><th>发行/簿记日期</th></tr></thead><tbody>{#each dynamicProjects as project}<tr><td>{project.name}</td><td>{project.amountDescription ?? `${amount(project.amountYi)}E`}</td><td>{project.tenorDescription ?? '数据缺失'}</td><td>{projectRate(project)}</td><td>{dateLabel(project.plannedIssueDate)}</td></tr>{:else}<tr><td colspan="5" class="table-empty">{hasSnapshot ? '暂无融资计划' : '暂无可靠数据'}</td></tr>{/each}</tbody></table></div></div></div>
</section>

<section class="report-section" aria-labelledby="section-2-title">
	<div class="card-head"><div class="section-title-wrap"><span class="section-tag">第二部分</span><h2 id="section-2-title" class="section-title">负债核心数据总览与指标监控</h2></div></div>
	<div class="core-panel"><div class="p1-grid"><div class="p1card accent-cyan"><div class="p1tag">资产负债规模</div><div class="dual-value"><span>总资产</span><strong>{amount(report.parameters.total_assets?.valueYi)}<em>亿元</em></strong></div><div class="dual-value"><span>总负债</span><strong>{amount(report.parameters.total_liabilities?.valueYi)}<em>亿元</em></strong></div></div><div class="p1card"><div class="p1tag">主动负债余额</div><div class="p1num">{amount(report.metrics.balanceYi)}<em>亿元</em></div><div class="p1sub">较上月末 <b>{signed(report.metrics.balanceMonthChangeYi)}</b> 亿元<br />较上年末 <b>{signed(report.metrics.balanceYearChangeYi)}</b> 亿元</div></div><div class="p1card accent-cyan"><div class="p1tag">资产负债率</div><div class="p1num">{report.parameters.adjusted_asset_liability_ratio?.valueYi == null ? '数据缺失' : percent(report.parameters.adjusted_asset_liability_ratio.valueYi * 100, 2)}</div><div class="p1sub">扣代理买卖</div></div><div class="p1card accent-amber"><div class="p1tag">加权融资利率</div><div class="p1num">{report.metrics.weightedRatePct == null ? '数据缺失' : `${amount(report.metrics.weightedRatePct, 2)}%`}</div><div class="p1sub">较上月末 <b>{signed(report.metrics.weightedRateMonthBp, 1)}</b> bp<br />较上年末 <b>{signed(report.metrics.weightedRateYearBp, 1)}</b> bp</div></div><div class="p1card accent-amber"><div class="p1tag">加权剩余期限</div><div class="p1num">{#if report.metrics.weightedRemainingDays == null}数据缺失{:else}{amount(report.metrics.weightedRemainingDays, 0)}<em>天</em>{/if}</div><div class="p1sub">较上月末 <b>{signed(report.metrics.remainingMonthChangeDays, 1)}</b> 天<br />较上年末 <b>{signed(report.metrics.remainingYearChangeDays, 1)}</b> 天</div></div><div class="p1card accent-amber"><div class="p1tag">长期负债占比</div><div class="p1num">{percent(report.metrics.longBalanceRatio)}</div><div class="p1sub">长期 <b>{amount(report.metrics.longBalanceYi, 0)}</b> 亿元<br />短期 <b>{amount(report.metrics.shortBalanceYi, 0)}</b> 亿元</div></div><div class="p1card accent-red"><div class="p1tag">未来30天到期</div><div class="p1num danger">{amount(report.metrics.due30Yi)}<em>亿元</em></div><div class="p1sub">到期日 {isoDate(addDays(report.asOfDate, 30))} 前<br />占主动负债 <b>{share(report.metrics.due30Yi, report.metrics.balanceYi)}</b></div></div><div class="p1card accent-red"><div class="p1tag">年内到期</div><div class="p1num danger">{amount(report.metrics.dueYearYi)}<em>亿元</em></div><div class="p1sub">到期日 {isoDate(yearEnd(report.asOfDate))} 前<br />占主动负债 <b>{share(report.metrics.dueYearYi, report.metrics.balanceYi)}</b></div></div></div></div>
	<div class="p1-gauge-row">
		{#each [{ label: '（短融+短期公司债+同业拆借）/上月末净资本', value: report.metrics.shortCompanyDebtRatio, numerator: report.metrics.shortCompanyDebtYi, denominator: report.parameters.prior_month_net_capital?.valueYi, warning: 48, limit: 60, maxLabel: '60%' }, { label: '发行期限1年以内短期负债 / 净资本', value: report.metrics.shortDebtRatio, numerator: report.metrics.shortDebtYi, denominator: report.parameters.prior_month_net_capital?.valueYi, warning: 80, limit: 100, maxLabel: '100%' }, { label: '新增单笔借款 / 证券上年末净资产', value: report.metrics.largestBorrowingRatio, numerator: report.metrics.largestBorrowingYi, denominator: report.parameters.securities_prior_year_net_assets?.valueYi, warning: 16, limit: 20, maxLabel: '20%' }, { label: '月末累计新增借款 / 证券上年末净资产', value: report.metrics.cumulativeSecuritiesRatio, numerator: report.metrics.cumulativeBorrowingYi, denominator: report.parameters.securities_prior_year_net_assets?.valueYi, warning: 40, limit: 50, maxLabel: '50%' }, { label: '月末累计新增借款 / 集团上年末净资产', value: report.metrics.cumulativeGroupRatio, numerator: report.metrics.cumulativeBorrowingYi, denominator: report.parameters.group_prior_year_net_assets?.valueYi, warning: 8, limit: 10, maxLabel: '10%' }] as gauge}
			{@const state = gaugeState(gauge.value, gauge.warning, gauge.limit)}
			<div class={`p1gauge gauge-${state.key}`}>
				<div class="p1gauge-head"><span>监管监控</span><strong>{state.label}</strong></div>
				<div class="p1gauge-t">{gauge.label}</div>
				<ReportGaugeChart label={gauge.label} value={gauge.value} warning={gauge.warning} limit={gauge.limit} maxLabel={gauge.maxLabel} />
				<div class="p1gauge-s"><b>{numberOrDash(gauge.numerator)}</b><span>/ {numberOrDash(gauge.denominator)} 亿元</span></div>
				<div class="p1gauge-warn"><span>预警 {gauge.warning}%</span><b>上限 {gauge.maxLabel}</b></div>
			</div>
		{/each}
	</div>
</section>
		</div>
		<footer class="bento-footer" aria-label="第 1 页"><span>东方财富证券股份有限公司 · 资金管理部</span><span>第 1 页 · 共 6 页</span></footer>
	</article>

	<article class="report-page">
		<div class="report-page-body">
			<section class="report-section" aria-labelledby="section-3-title">
	<div class="card-head"><div class="section-title-wrap"><span class="section-tag">第三部分</span><h2 id="section-3-title" class="section-title">融资额度及余额情况</h2></div></div>
	<div class="bento-card"><div class="inner-card-title">● 融资批复额度使用情况表 <span>单位：亿元</span></div><div class="table-scroll"><table class="bento-table quota-table"><thead><tr><th>融资品种</th><th class="num">可用额度</th><th class="num">已用额度</th><th class="num">剩余额度</th><th>获批日期与规则</th><th>额度使用进度</th></tr></thead><tbody>{#each report.limits as item, limitIndex}<tr><td class="quota-name"><i style={`--quota-color:${liabilityTypeColor(item.debtType, limitIndex)}`}></i>{item.debtType}</td><td class="num">{amount(item.limitYi)}</td><td class="num">{amount(item.issuedYi)}</td><td class="num" class:negative={item.remainingYi < 0}>{amount(item.remainingYi)}</td><td>{approvalRule(item)}</td><td><div class="quota-progress"><ReportProgressChart label={item.debtType} value={quotaPercent(item.issuedYi, item.limitYi)} /></div></td></tr>{:else}<tr><td colspan="6" class="table-empty">暂无额度数据</td></tr>{/each}</tbody><tfoot><tr><th>合计</th><th class="num">{amount(report.limitTotals.limitYi)}</th><th class="num">{amount(report.limitTotals.issuedYi)}</th><th class="num">{amount(report.limitTotals.remainingYi)}</th><th></th><th><div class="quota-progress"><ReportProgressChart label="合计" value={quotaPercent(report.limitTotals.issuedYi, report.limitTotals.limitYi)} /></div></th></tr></tfoot></table></div></div>
	<div class="chart-container composition-panel"><div class="composition-layout"><div class="composition-donut"><ReportDonutChart rows={report.composition} total={compositionTotal} /></div><div class="table-scroll"><table class="bento-table composition-table"><thead><tr><th>融资品种</th><th class="num">余额（亿元）</th><th class="num">占比</th></tr></thead><tbody>{#each report.composition as item, index}<tr><td><i style={`--legend-color:${liabilityTypeColor(item.type, index)}`}></i>{item.type || '未分类'}</td><td class="num">{amount(item.amountYi)}</td><td class="num">{compositionTotal ? percent(item.amountYi / compositionTotal * 100, 2) : '数据缺失'}</td></tr>{/each}<tr class="total-row"><td>合计</td><td class="num">{hasSnapshot ? amount(compositionTotal) : '数据缺失'}</td><td class="num">{hasSnapshot ? '100.00%' : '数据缺失'}</td></tr></tbody></table></div></div></div>
</section>
		</div>
		<footer class="bento-footer" aria-label="第 2 页"><span>东方财富证券股份有限公司 · 资金管理部</span><span>第 2 页 · 共 6 页</span></footer>
	</article>

	<article class="report-page">
		<div class="report-page-body">
			<section class="report-section" aria-labelledby="section-4-title"><div class="card-head"><div class="section-title-wrap"><span class="section-tag">第四部分</span><h2 id="section-4-title" class="section-title">负债规模及利率走势</h2></div></div><div class="chart-container large-chart"><h3>公司融资余额及综合融资利率走势</h3><ReportBalanceRateChart rows={report.balanceRateTrend ?? []} /><div class="chart-foot"><span>图：2021 年至今公司加权平均融资利率与融资余额（亿元，%）</span></div></div><div class="chart-container large-chart"><h3>近一年公司债券发行规模及利率走势</h3><ReportIssuanceChart rows={report.issuanceTrend ?? []} /><div class="chart-foot"><span>图：公司近一年短融、3年/5年公募债及次级债发行规模与分品种加权利率（亿元，%）</span></div></div></section>
		</div>
		<footer class="bento-footer" aria-label="第 3 页"><span>东方财富证券股份有限公司 · 资金管理部</span><span>第 3 页 · 共 6 页</span></footer>
	</article>

	<article class="report-page">
		<div class="report-page-body">
			<section class="report-section" aria-labelledby="section-5-title"><div class="card-head"><div class="section-title-wrap"><span class="section-tag">第五部分</span><h2 id="section-5-title" class="section-title">负债到期分布全景</h2></div></div><div class="chart-container large-chart"><ReportStackedBarChart title="未来12个月负债逐月到期规模分布" rows={maturityRows} labels={maturityLabels} types={maturityTypes} height={300} /><div class="chart-foot"><span>图 1：未来 12 个月负债逐月到期规模分布（按品种）（亿元）</span></div></div><div class="chart-container large-chart"><ReportStackedBarChart title="存量负债年度到期阶梯与品种构成" rows={annualRows} labels={annualLabels} types={annualTypes} height={280} /><div class="chart-foot"><span>图 2：存量负债年度到期阶梯与品种构成（亿元）</span></div></div><div class="card-head inner-section-head"><h3>未来30天负债到期明细</h3><span class="badge-tag">单位：亿元</span></div><div class="table-scroll"><table class="bento-table maturity-table"><thead><tr><th>品种</th><th>对手方</th><th class="num">本金</th><th class="num">应付利息</th><th class="num">利率</th><th>到期日</th></tr></thead><tbody>{#each report.dueDetails as item}<tr><td><a href={withBase(`/debts/${item.id}`)}>{item.debt_type}</a></td><td>{item.counterparty ?? '—'}</td><td class="num">{amount(item.principalYi)}</td><td class="num">{numberOrDash(item.interestYi)}</td><td class="num">{item.annualRatePct == null ? '数据缺失' : `${amount(item.annualRatePct, 2)}%`}</td><td>{dateLabel(item.dueDate ?? item.maturityDate)}</td></tr>{:else}<tr><td colspan="6" class="table-empty">{hasSnapshot ? '未来30天无负债本金到期明细' : '暂无可靠数据'}</td></tr>{/each}</tbody><tfoot><tr><th>合计</th><th></th><th class="num">{amount(hasSnapshot ? report.dueDetails.reduce((sum: number, item: any) => sum + Number(item.principalYi ?? 0), 0) : null)}</th><th class="num">{amount(hasSnapshot ? report.dueDetails.reduce((sum: number, item: any) => sum + Number(item.interestYi ?? 0), 0) : null)}</th><th></th><th></th></tr></tfoot></table></div></section>
		</div>
		<footer class="bento-footer" aria-label="第 4 页"><span>东方财富证券股份有限公司 · 资金管理部</span><span>第 4 页 · 共 6 页</span></footer>
	</article>

	<article class="report-page">
		<div class="report-page-body">
			<section class="report-section" aria-labelledby="section-6-title">
	<div class="card-head"><div class="section-title-wrap"><span class="section-tag">第六部分</span><h2 id="section-6-title" class="section-title">可比券商申报及发行</h2></div></div>
	<div class="chart-container large-chart"><h3>{String(report.asOfDate).slice(0, 4)}年以来证券公司债券发行规模与品种构成（亿元）</h3><ReportStackedBarChart title="可比券商债券发行规模与品种构成" rows={peerRows} labels={peerLabels} types={peerTypes} height={430} horizontal highlightLabel="东方财富" /></div>
		<div class="peer-columns">
			<div class="peer-column">
			<div class="bento-card">
				<div class="inner-card-title">● 本周券商债券发行定价</div>
				{@render peerPricingTable(report.peerIssuances ?? [])}
			</div>
			<div class="bento-card">
				<div class="inner-card-title">● 本周券商债券申报动态</div>
				{@render peerRegistrationTable(peerRegistrationColumns[0] ?? [])}
			</div>
			</div>
			<div class="peer-column">
			{#if peerRegistrationColumns[1]?.length}
			<div class="bento-card">
				<div class="inner-card-title">● 本周券商债券申报动态（续表）</div>
				{@render peerRegistrationTable(peerRegistrationColumns[1] ?? [])}
			</div>
			{/if}
			</div>
		</div>
</section>
		</div>
		<footer class="bento-footer" aria-label="第 5 页"><span>东方财富证券股份有限公司 · 资金管理部</span><span>第 5 页 · 共 6 页</span></footer>
	</article>

	<article class="report-page">
		<div class="report-page-body">
			<section class="report-section" aria-labelledby="section-7-title"><div class="card-head"><div class="section-title-wrap"><span class="section-tag">第七部分</span><h2 id="section-7-title" class="section-title">利率走势看板</h2></div></div><div class="chart-container large-chart"><h3>{String(report.asOfDate).slice(0, 4)}年中债证券公司债（AAA-）期限利率走势</h3><ReportLineChart title="中债证券公司债AAA-期限利率走势" rows={marketRows('chinabond_broker_aaa_minus_yield')} height={330} /></div><div class="rate-grid">{#each marketCategories as category}<div class="chart-container rate-card"><h3>{String(report.asOfDate).slice(0, 4)}年{category.title}</h3><ReportLineChart title={category.title} rows={marketRows(category.key)} height={250} compact /></div>{/each}</div></section>
		</div>
		<footer class="bento-footer" aria-label="第 6 页"><span>东方财富证券股份有限公司 · 资金管理部</span><span>第 6 页 · 共 6 页</span></footer>
	</article>
</div>
{/key}
{/if}
