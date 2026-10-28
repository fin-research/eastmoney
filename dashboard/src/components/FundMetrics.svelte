<script lang="ts">
  import { number, signed, tone } from "../formatters";
  import type { MarketMetric } from "../types";

  interface Props {
    metrics: MarketMetric[];
  }

  let { metrics }: Props = $props();
</script>

{#each metrics as item (item.label)}
  <article
    class={`market-stat-card card--segmented card--centered market-indicator card--${tone(item.change)}`}
  >
    <div class="card__content">
      <span class="card__label">{item.label}</span>
      <strong class="card__value">{number(item.value, 4)}%</strong>
      <small class="card__detail">{signed(item.change, "bp")}</small>
    </div>
  </article>
{/each}

