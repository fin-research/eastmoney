<script lang="ts">
  import type { ReportDerived } from "../report-view";
  import type { MarketReportResource, ReportData } from "../types";
  import { coreMetricCards } from "../view-model";
  import MetricCard from "./MetricCard.svelte";
  import MetricIcon from "./MetricIcon.svelte";

  interface Props {
    data: ReportData;
    reportDerived: ReportDerived;
    missingResources?: MarketReportResource[];
  }

  let { data, reportDerived, missingResources = [] }: Props = $props();

  let cards = $derived(coreMetricCards(data, reportDerived, missingResources));

  const metricToneByIcon = {
    bank: "green",
    liquidity: "blue",
    bond: "orange",
    equity: "red",
    issuance: "purple",
    trade: "cyan",
    leverage: "blue",
    profit: "green",
  } as const;

  function detailTone(valueTone: string): string {
    if (valueTone === "up") return "tone-up";
    if (valueTone === "down") return "tone-down";
    if (valueTone === "inject") return "tone-inject";
    if (valueTone === "withdraw") return "tone-withdraw";
    return "tone-flat";
  }
</script>

{#each cards as item (item.label)}
  <MetricCard
    label={item.label}
    value={item.value ?? "—"}
    detail={item.detail ?? ""}
    detailTone={detailTone(item.valueTone)}
    tone={metricToneByIcon[item.icon]}
    iconComponent={MetricIcon}
    iconProps={{ icon: item.icon }}
  />
{/each}
