<script lang="ts">
  import { Alert } from "$lib/components/ui/alert/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import type { PageData } from './$types';
  import InvestorChartTable from '$lib/financing/InvestorChartTable.svelte';
  import { investorBondTypes, investorShare, type InvestorAmounts } from '$lib/financing/bond-investors';
  import { investorRankingOption, investorStructureOption } from '../../../charts/bond-investors';
  import { financingCompositionOption } from '../../../charts/financing-dashboard';
  let { data }: { data: PageData } = $props();
  let totalType = $state<keyof InvestorAmounts>('total');
  let outstandingType = $state<keyof InvestorAmounts>('total');
  let investorType = $state<keyof InvestorAmounts>('total');
  let sort = $state<'total' | 'outstanding'>('total');
  const report = $derived(data.report);
  const columns = ['机构类型', ...investorBondTypes, '合计'];
  const amounts = (row: InvestorAmounts) => [...investorBondTypes.map(type => row[type]), row.total];
  const totalDistribution = $derived(report.categories.map(row => ({ name: row.category, values: [row.total[totalType], investorShare(row.total[totalType], report.total[totalType])] })));
  const outstandingDistribution = $derived(report.categories.map(row => ({ name: row.category, values: [row.outstanding[outstandingType], investorShare(row.outstanding[outstandingType], report.outstanding[outstandingType])] })));
  const ranking = $derived(report.investors.map(row => ({ name: row.name, total: row.total[investorType], outstanding: row.outstanding[investorType] })).filter(row => row.total > 0).sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name, 'zh-CN')));
</script>

<svelte:head><title>债券投资人 · 融资工作台</title></svelte:head>

<div class="investor-page">
  <form method="GET" class="investor-toolbar">
    <label for="investor-date">统计日</label><Input data-ui-owner="routes-financing-bond-investors--page-svelte" id="investor-date" class={"ui-input "} type="date" name="date" min="2020-01-01" value={report.asOfDate} required />
    <Button data-ui-owner="routes-financing-bond-investors--page-svelte" variant="default" class={"ui-button "} type="submit">查询</Button><span>金额单位：亿元</span>
  </form>
  {#if report.coverage.missingBonds > 0}<Alert role="status">已登记 {report.coverage.coveredBonds} 只债券的投资人；另有 {report.coverage.missingBonds} 只已发行债券尚无投资人明细，发行本金合计 {report.coverage.missingAmountYi.toFixed(2)} 亿元，未纳入下方统计。</Alert>{/if}
  {#if report.coverage.mismatchedBonds > 0}<Alert role="status" class="border-amber-200 bg-amber-50">{report.coverage.mismatchedBonds} 只债券的投资人合计与发行本金不一致，请核对台账。</Alert>{/if}
  {#if report.investors.length === 0}
    <Alert role="status">截至所选统计日暂无债券投资人数据。</Alert>
  {:else}
    <InvestorChartTable id="investor-total" title="累计债券融资情况" option={investorStructureOption(report.categories, 'total')} headers={columns}
      rows={report.categories.map(row => ({ name: row.category, values: amounts(row.total) }))} total={amounts(report.total)} />
    <InvestorChartTable id="investor-outstanding" title="存续债券融资情况" empty={report.outstanding.total === 0} option={investorStructureOption(report.categories, 'outstanding')} headers={columns}
      rows={report.categories.map(row => ({ name: row.category, values: amounts(row.outstanding) }))} total={amounts(report.outstanding)} />
    <InvestorChartTable id="investor-total-distribution" title="累计投资机构类型分布" empty={report.total[totalType] === 0} option={financingCompositionOption(totalDistribution.map(row => ({ type: row.name, amountYi: row.values[0] ?? 0 })), true)}
      headers={['机构类型', '累计规模', '占比']} rows={totalDistribution} total={[report.total[totalType], investorShare(report.total[totalType], report.total[totalType])]} percentages={[1]}>
      {#snippet controls()}<div class="investor-control"><label for="total-bond-type">债券品种</label><NativeSelect data-ui-owner="routes-financing-bond-investors--page-svelte" id="total-bond-type" class={"ui-select "} bind:value={totalType}><option value="total">全部品种</option>{#each investorBondTypes as type}<option value={type}>{type}</option>{/each}</NativeSelect></div>{/snippet}
    </InvestorChartTable>
    <InvestorChartTable id="investor-outstanding-distribution" title="存续投资机构类型分布" empty={report.outstanding[outstandingType] === 0} option={financingCompositionOption(outstandingDistribution.map(row => ({ type: row.name, amountYi: row.values[0] ?? 0 })), true)}
      headers={['机构类型', '存续规模', '占比']} rows={outstandingDistribution} total={[report.outstanding[outstandingType], investorShare(report.outstanding[outstandingType], report.outstanding[outstandingType])]} percentages={[1]}>
      {#snippet controls()}<div class="investor-control"><label for="outstanding-bond-type">债券品种</label><NativeSelect data-ui-owner="routes-financing-bond-investors--page-svelte" id="outstanding-bond-type" class={"ui-select "} bind:value={outstandingType}><option value="total">全部品种</option>{#each investorBondTypes as type}<option value={type}>{type}</option>{/each}</NativeSelect></div>{/snippet}
    </InvestorChartTable>
    <InvestorChartTable id="investor-ranking" title="具体投资人情况" empty={ranking.length === 0} option={investorRankingOption(ranking)} scroll chartHeight={Math.max(27, ranking.length * 3.8 + 6)}
      headers={['投资机构', '累计规模', '累计占比', '存续规模', '存续占比']} percentages={[1, 3]}
      rows={ranking.map(row => ({ name: row.name, values: [row.total, investorShare(row.total, report.total[investorType]), row.outstanding, investorShare(row.outstanding, report.outstanding[investorType])] }))}
      total={[report.total[investorType], investorShare(report.total[investorType], report.total[investorType]), report.outstanding[investorType], investorShare(report.outstanding[investorType], report.outstanding[investorType])]}>
      {#snippet controls()}
        <div class="investor-control"><label for="investor-bond-type">债券品种</label><NativeSelect data-ui-owner="routes-financing-bond-investors--page-svelte" id="investor-bond-type" class={"ui-select "} bind:value={investorType}><option value="total">全部品种</option>{#each investorBondTypes as type}<option value={type}>{type}</option>{/each}</NativeSelect></div>
        <div class="investor-control"><label for="investor-sort">排序</label><NativeSelect data-ui-owner="routes-financing-bond-investors--page-svelte" id="investor-sort" class={"ui-select "} bind:value={sort}><option value="total">累计规模</option><option value="outstanding">存续规模</option></NativeSelect></div>
      {/snippet}
    </InvestorChartTable>
  {/if}
</div>

<style>
  .investor-page { display: grid; gap: 1.25rem; min-width: 0; }
  .investor-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
  :global(.investor-toolbar input[data-ui-owner="routes-financing-bond-investors--page-svelte"]) { width: auto; }
  .investor-toolbar span { margin-left: auto; }
  @media (min-width: 901px) {
    .investor-control { display: flex; flex: 0 0 auto; align-items: center; gap: .5rem; }
    .investor-control label { white-space: nowrap; }
    .investor-control :global(select) { width: 9rem; flex: 0 0 auto; }
  }
  @media (max-width: 720px) { .investor-toolbar span { margin-left: 0; } }
</style>
