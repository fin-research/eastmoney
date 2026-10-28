<script lang="ts">
  import ChartHost from "../../components/ChartHost.svelte";
  import { renderEconomicIndicatorTrend } from "../../charts/trading-research";
  import {
    economicIndicatorChange,
    formatEconomicIndicatorChange,
    type EconomicIndicatorSeries,
  } from "./economic-indicators";

  let {
    indicator,
    accent,
    loading = false,
  }: {
    indicator: EconomicIndicatorSeries;
    accent: string;
    loading?: boolean;
  } = $props();

  const latest = $derived(indicator.points.at(-1));
  const change = $derived(economicIndicatorChange(indicator.points));
  const displayChange = $derived(
    formatEconomicIndicatorChange(change, indicator.decimals),
  );
  const displayValue = $derived(
    latest
      ? latest.value.toLocaleString("zh-CN", {
          minimumFractionDigits: indicator.decimals,
          maximumFractionDigits: indicator.decimals,
        })
      : "—",
  );
  const chartLabel = $derived(
    `${indicator.name}${indicator.frequency}走势${indicator.unit ? `，单位${indicator.unit}` : ""}`,
  );
</script>

<article
  class:tr-economic-card--loading={loading}
  class="tr-economic-card"
  style={`--tr-economic-accent: ${accent}`}
>
  <header class="tr-economic-card__header">
    <h3>{indicator.name}</h3>
  </header>

  <div class="tr-economic-card__value" aria-live="polite">
    {#if loading}
      <span class="tr-economic-skeleton tr-economic-skeleton--value"></span>
    {:else}
      <div class="tr-economic-card__primary">
        <strong>{displayValue}</strong>
        {#if indicator.unit}<span>{indicator.unit}</span>{/if}
      </div>
      <span
        class:tr-economic-card__change--up={change !== null && change > 0}
        class:tr-economic-card__change--down={change !== null && change < 0}
        class="tr-economic-card__change"
        aria-label={`较上一期变化 ${displayChange}${indicator.unit ? ` ${indicator.unit}` : ""}`}
      >
        {displayChange}{#if change !== null && indicator.unit}<small>{indicator.unit}</small>{/if}
      </span>
    {/if}
  </div>

  <div class="tr-economic-card__trend">
    {#if loading}
      <span class="tr-economic-skeleton tr-economic-skeleton--chart"></span>
    {:else if indicator.points.length > 0}
      <ChartHost
        renderer={renderEconomicIndicatorTrend}
        args={[
          indicator.points,
          chartLabel,
          indicator.unit,
          indicator.decimals,
          accent,
        ]}
        ariaLabel={chartLabel}
        className="tr-economic-chart"
      />
    {:else}
      <div class="tr-economic-card__empty">暂无可用数据</div>
    {/if}
  </div>

  <footer>
    <span>{loading ? "数据加载中" : latest ? `更新于 ${latest.date}` : "日期待更新"}</span>
    <span>{indicator.frequency}</span>
  </footer>
</article>
