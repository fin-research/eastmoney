<script lang="ts">
  import { number, signed, tone } from "../formatters";
  import type { EquityPoint } from "../types";

  interface Props {
    points: EquityPoint[];
  }

  let { points }: Props = $props();

  let valid = $derived(points
    .filter(
      (point) =>
        Number.isFinite(point.close) && Number.isFinite(point.change_pct),
    )
    .slice(0, 4));
</script>

{#each valid as point (point.name)}
  <article class="equity-value">
    <span class="equity-value__name">{point.name}</span>
    <div class="equity-value__numbers">
      <strong>{number(point.close, 2)}</strong>
      <small class={`tone-${tone(point.change_pct)}`}
        >{signed(point.change_pct, "%")}</small
      >
    </div>
  </article>
{/each}
