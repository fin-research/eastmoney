<script lang="ts">
  import * as Table from '$lib/components/ui/table/index.js';
  import type { Snippet } from 'svelte';
  import ModuleCard from '../../components/ModuleCard.svelte';
  import ChartHost from '../../components/ChartHost.svelte';
  import PanelHeading from '../trading-research/PanelHeading.svelte';
  import type { ChartOption } from '../../charts/charting';
  let { id, title, option, headers, rows, total, percentages = [], chartHeight = 27, scroll = false, empty = false, controls }: {
    id: string; title: string; option: ChartOption;
    headers: string[]; rows: { name: string; values: (number | null)[] }[];
    total: (number | null)[]; percentages?: number[]; chartHeight?: number; scroll?: boolean; empty?: boolean; controls?: Snippet;
  } = $props();
  const number = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const display = (value: number | null, column: number) => value == null ? '—' : percentages.includes(column) ? `${(value * 100).toFixed(2)}%` : number.format(value);
</script>

<ModuleCard labelledBy={id}>
  <PanelHeading {id} {title} controlsInline>
    {#if controls}{@render controls()}{/if}
  </PanelHeading>
  <div class="investor-pair">
    <div class:scroll class="investor-chart" role="region" aria-label={`${title}图表滚动区域`}>
      {#if empty}<p class="empty-chart" role="status">所选范围暂无投资金额</p>{:else}<ChartHost {option} height={chartHeight} ariaLabel={`${title}，金额单位亿元`} />{/if}
    </div>
    <div class:scroll class="investor-table" role="region" aria-label={`${title}数据表格`}>
      <Table.Root scrollable={false}>
        <caption class="sr-only">{title}，金额单位亿元</caption>
        <Table.Header><Table.Row>{#each headers as header, index}<Table.Head scope="col" class={index > 0 ? 'numeric' : undefined}>{header}</Table.Head>{/each}</Table.Row></Table.Header>
        <Table.Body>
          {#each rows as row}<Table.Row><Table.Head scope="row">{row.name}</Table.Head>{#each row.values as value, index}<Table.Cell class="numeric">{display(value, index)}</Table.Cell>{/each}</Table.Row>{/each}
        </Table.Body>
        <Table.Footer><Table.Row><Table.Head scope="row">合计</Table.Head>{#each total as value, index}<Table.Cell class="numeric">{display(value, index)}</Table.Cell>{/each}</Table.Row></Table.Footer>
      </Table.Root>
    </div>
  </div>
</ModuleCard>

<style>
  .investor-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); align-items: start; gap: 1.5rem; }
  .investor-chart, .investor-table { min-width: 0; overflow: auto; }
  .scroll { max-height: 34rem; }
  .empty-chart { min-height: 20rem; display: grid; place-items: center; }
  .investor-table :global(table) { width: 100%; font-size: 0.875rem; }
  .investor-table :global(th) { text-align: left; }
  .investor-table :global(.numeric) { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .investor-table :global(thead) { position: sticky; top: 0; background: var(--surface); z-index: 1; }
  .investor-table :global(tfoot) { font-weight: bold; background: var(--panel); }
  .investor-table :global(tbody th) { font-weight: normal; min-width: 6rem; }
  @media (max-width: 1050px) { .investor-pair { grid-template-columns: minmax(0, 1fr); } }
</style>
