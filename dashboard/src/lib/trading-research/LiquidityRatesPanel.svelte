<script lang="ts">
  import ChartHost from "../../components/ChartHost.svelte";
  import MetricCard from "../../components/MetricCard.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import {
    renderLiquidityRateChart,
    type LiquidityRateChartSeries,
  } from "../../charts/trading-research";
  import type {
    EconomicIndicatorPoint,
    EconomicIndicatorSeries,
  } from "./economic-indicators";
  import PanelHeading from "./PanelHeading.svelte";
  import WorkbenchIcon from "./WorkbenchIcon.svelte";

  let {
    rates,
    loading = false,
  }: {
    rates: EconomicIndicatorSeries[];
    loading?: boolean;
  } = $props();

  const byKey = $derived(new Map(rates.map((series) => [series.key, series])));
  const mainSeries = $derived(
    chartSeries([
      ["reverse-repo-7d", "#d92d20"],
      ["dr007", "#2f6fed"],
      ["ncd-aaa-1y", "#f79009"],
      ["cgb-1y", "#12b76a"],
      ["cgb-10y", "#6941c6"],
      ["cgb-30y", "#0ba5ec"],
    ]),
  );
  const liquiditySpreadSeries = $derived([
    {
      name: "压力利差",
      color: "#d92d20",
      points: spreadPoints(byKey.get("r007"), byKey.get("dr007")),
    },
  ] satisfies LiquidityRateChartSeries[]);
  const curveSpreadSeries = $derived([
    {
      name: "中短端",
      color: "#6941c6",
      points: spreadPoints(byKey.get("cgb-10y"), byKey.get("cgb-1y")),
    },
    {
      name: "超长端",
      color: "#0ba5ec",
      points: spreadPoints(byKey.get("cgb-30y"), byKey.get("cgb-10y")),
    },
  ] satisfies LiquidityRateChartSeries[]);

  const metrics = $derived([
    metric("DR001", "dr001", "blue"),
    metric("DR007", "dr007", "teal"),
    metric("R007", "r007", "orange"),
    metric("1Y NCD", "ncd-aaa-1y", "purple"),
  ] as const);

  function chartSeries(
    definitions: ReadonlyArray<readonly [string, string]>,
  ): LiquidityRateChartSeries[] {
    return definitions.flatMap(([key, color]) => {
      const series = byKey.get(key);
      return series ? [{ name: series.name, color, points: series.points }] : [];
    });
  }

  function spreadPoints(
    longSeries: EconomicIndicatorSeries | undefined,
    shortSeries: EconomicIndicatorSeries | undefined,
  ): EconomicIndicatorPoint[] {
    if (!longSeries || !shortSeries) return [];
    const shortByDate = new Map(
      shortSeries.points.map((point) => [point.date, point.value]),
    );
    return longSeries.points.flatMap((point) => {
      const shortValue = shortByDate.get(point.date);
      return shortValue === undefined
        ? []
        : [{ date: point.date, value: (point.value - shortValue) * 100 }];
    });
  }

  function metric(
    label: string,
    key: string,
    tone: "blue" | "teal" | "orange" | "purple",
  ): {
    label: string;
    value: string;
    detail: string;
    detailTone: string;
    tone: "blue" | "teal" | "orange" | "purple";
  } {
    const series = byKey.get(key);
    const latest = series?.points.at(-1);
    const previous = series?.points.at(-2);
    const changeBp =
      latest && previous ? (latest.value - previous.value) * 100 : null;
    return {
      label,
      value: latest ? latest.value.toFixed(series?.decimals ?? 4) : "—",
      detail: loading ? "" : formatBp(changeBp),
      detailTone: deltaTone(changeBp),
      tone,
    };
  }

  function formatBp(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "";
    const normalized = Math.abs(value) < 0.005 ? 0 : value;
    const sign = normalized >= 0 ? "+" : "−";
    return `${sign}${Math.abs(normalized).toFixed(2)} bp`;
  }

  function deltaTone(value: number | null): string {
    if (value === null || !Number.isFinite(value) || Math.abs(value) < 0.005) {
      return "tone-flat";
    }
    return value > 0 ? "tone-up" : "tone-down";
  }
</script>

<ModuleCard class="tr-liquidity-panel" labelledBy="liquidity-rates-title">
  <PanelHeading
    id="liquidity-rates-title"
    title="利率与资金面"
    accent="#2f6fed"
  />

  <div class="tr-liquidity-metrics">
    {#each metrics as item (item.label)}
      <MetricCard
        label={item.label}
        value={item.value}
        unit="%"
        detail={item.detail}
        detailTone={item.detailTone}
        tone={item.tone}
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "funds" }}
        compact
      />
    {/each}
  </div>

  <div class="tr-liquidity-main">
    {#if mainSeries.some((series) => series.points.length > 0)}
      <ChartHost
        renderer={renderLiquidityRateChart}
        args={[mainSeries, "利率与资金面主要利率走势", "%", 3]}
        ariaLabel="7D逆回购、DR007、1年AAA同业存单及1年、10年、30年国债收益率走势"
        className="tr-liquidity-main-chart"
      />
    {:else}
      <div class="tr-liquidity-empty">{loading ? "数据加载中" : "暂无可用数据"}</div>
    {/if}
  </div>

  <div class="tr-liquidity-secondary">
    <section aria-labelledby="liquidity-spread-title">
      <header>
        <h3 id="liquidity-spread-title">非银流动性压力</h3>
      </header>
      {#if liquiditySpreadSeries[0]?.points.length}
        <ChartHost
          renderer={renderLiquidityRateChart}
          args={[liquiditySpreadSeries, "非银流动性压力利差", "bp", 2, false]}
          ariaLabel="非银流动性压力利差走势"
          className="tr-liquidity-mini-chart"
        />
      {:else}
        <div class="tr-liquidity-empty tr-liquidity-empty--mini">暂无可用数据</div>
      {/if}
    </section>

    <section aria-labelledby="curve-spread-title">
      <header>
        <h3 id="curve-spread-title">期限利差</h3>
      </header>
      {#if curveSpreadSeries.some((series) => series.points.length > 0)}
        <ChartHost
          renderer={renderLiquidityRateChart}
          args={[curveSpreadSeries, "国债期限利差", "bp", 2]}
          ariaLabel="国债中短端与超长端期限利差走势"
          className="tr-liquidity-mini-chart"
        />
      {:else}
        <div class="tr-liquidity-empty tr-liquidity-empty--mini">暂无可用数据</div>
      {/if}
    </section>
  </div>
</ModuleCard>
