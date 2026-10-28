<script lang="ts">
  import type { PrimaryIssueDetail } from "../types";
  import { primaryRows } from "../view-model";

  interface Props {
    points: PrimaryIssueDetail[];
  }

  let { points }: Props = $props();

  let rows = $derived(primaryRows(points));
</script>

{#if !rows.length}
  <div class="primary-table__empty">今日暂无可比发行</div>
{:else}
  <table class="ui-table primary-table">
    <thead>
      <tr>
        {#each ["类型", "日期", "发行人", "期限", "规模", "票息"] as label}
          <th>{label}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, rowIndex (`${row.title}-${rowIndex}`)}
        <tr title={row.title}>
          <td>
            <span
              class={`ui-badge primary-badge primary-badge--${row.tagIndex}`}
              >{row.values[0]}</span
            >
          </td>
          <td>{row.values[1]}</td>
          <td class="primary-table__issuer">{row.values[2]}</td>
          <td>{row.values[3]}</td>
          <td>{row.values[4]}</td>
          <td>{row.values[5]}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
