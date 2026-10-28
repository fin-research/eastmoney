<script lang="ts">
  import ModuleCard from '../../components/ModuleCard.svelte';
  import PanelHeading from '../trading-research/PanelHeading.svelte';
  import SectionHeading from '../trading-research/SectionHeading.svelte';
  import { scrollableRegion } from '../scrollable-region';
  import { buildBankCreditStatus } from '../credit/bank-status.ts';
  import type { CreditReportResponse } from '../credit/types.ts';

  let { report }: { report: CreditReportResponse } = $props();
  const bankCredit = $derived(buildBankCreditStatus(report.institutions));
  const format = (value: number | null) => value == null ? '—' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
</script>

<SectionHeading id="bank-credit-title" title="银行授信情况" meta={`数据时点：${report.summary.reportDate}`} />
{#each [
  { id: 'bank-credit-summary', title: '银行性质汇总', label: '银行性质', rows: bankCredit.groups, total: bankCredit.total },
  { id: 'bank-credit-top', title: '前十大授信机构明细', label: '授信机构', rows: bankCredit.topInstitutions, total: null },
] as table (table.id)}
  <ModuleCard labelledBy={`${table.id}-title`}>
    <PanelHeading id={`${table.id}-title`} title={table.title} controlsInline><span>亿元</span></PanelHeading>
    <div class="tr-table-scroll" role="region" aria-label={table.title} use:scrollableRegion>
      <table class="tr-data-table bank-credit-table" aria-label={table.title}>
        <thead><tr><th scope="col">{table.label}</th><th scope="col" class="is-numeric">授信额度</th><th scope="col" class="is-numeric">已用额度</th><th scope="col" class="is-numeric">剩余额度</th></tr></thead>
        <tbody>
          {#each table.rows as row (row.label)}
            <tr><th scope="row">{row.label}</th><td class="is-numeric">{format(row.totalLimit)}</td><td class="is-numeric">{format(row.totalUsed)}</td><td class="is-numeric">{format(row.remaining)}</td></tr>
          {:else}<tr><td colspan="4" class="tr-empty-state">暂无授信机构</td></tr>{/each}
        </tbody>
        {#if table.total}<tfoot><tr><th scope="row"><strong>合计</strong></th><td class="is-numeric"><strong>{format(table.total.totalLimit)}</strong></td><td class="is-numeric"><strong>{format(table.total.totalUsed)}</strong></td><td class="is-numeric"><strong>{format(table.total.remaining)}</strong></td></tr></tfoot>{/if}
      </table>
    </div>
  </ModuleCard>
{/each}

<style>
  .bank-credit-table { min-width: 34rem; font-size: 1rem; }
  .bank-credit-table th:first-child { width: 40%; white-space: normal; overflow-wrap: anywhere; }
  .bank-credit-table :is(th, td) { height: 3.25rem; padding-inline: 1rem; }
  .bank-credit-table tfoot { color: var(--tr-text); background: var(--tr-primary-soft); font-weight: bold; }
  .bank-credit-table tfoot :is(th, td) { border-top: 1px solid var(--tr-border); border-bottom: 0; }
</style>
