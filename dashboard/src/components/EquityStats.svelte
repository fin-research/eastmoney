<script lang="ts">
  import type { ReportData } from "../types";
  import type { MarginSnapshot } from "../types";
  import { equityStatCards } from "../view-model";
  import StatIcon from "./StatIcon.svelte";

  interface Props {
    data: ReportData;
    margin: MarginSnapshot;
  }

  let { data, margin }: Props = $props();
  let items = $derived(equityStatCards(data, margin));
</script>

{#each items as item (item.label)}
  <article class={`market-stat-card stat-card card--${item.valueTone}`}>
    <StatIcon icon={item.icon} />
    <div class="card__content stat-card__content">
      <span class="card__label">{item.label}</span>
      <strong class="card__value">{item.value}</strong>
      <div class="stat-card__footer">
        <small class="card__detail">{item.change}</small>
      </div>
    </div>
  </article>
{/each}
