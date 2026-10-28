<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount } from "svelte";

  import { portal } from "../portal";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import EconomicIndicatorCard from "./EconomicIndicatorCard.svelte";
  import LiquidityRatesPanel from "./LiquidityRatesPanel.svelte";
  import PanelHeading from "./PanelHeading.svelte";
  import SectionHeading from "./SectionHeading.svelte";
  import WorkbenchIcon from "./WorkbenchIcon.svelte";
  import {
    emptyEconomicIndicatorGroups,
    emptyLiquidityRateSeries,
    fetchEconomicIndicatorSnapshot,
    formatEconomicDataRefresh,
  } from "./economic-indicators";

  let groups = $state(emptyEconomicIndicatorGroups());
  let liquidityRates = $state(emptyLiquidityRateSeries());
  let syncedAt = $state("");
  let loading = $state(true);
  let error = $state("");
  let controller: AbortController | undefined;

  async function loadIndicators(): Promise<void> {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    loading = true;
    error = "";
    try {
      const snapshot = await fetchEconomicIndicatorSnapshot(
        requestController.signal,
      );
      groups = snapshot.groups;
      liquidityRates = snapshot.liquidityRates;
      syncedAt = snapshot.syncedAt;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      error = cause instanceof Error ? cause.message : "经济指标加载失败";
    } finally {
      if (!requestController.signal.aborted) loading = false;
    }
  }

  onMount(() => {
    void loadIndicators();
    return () => controller?.abort();
  });
</script>

{#if syncedAt}
  <span class="tr-as-of" use:portal={"#tr-topbar-actions"}>
    <WorkbenchIcon name="calendar" />
    <span>数据更新</span>
    <strong>{formatEconomicDataRefresh(syncedAt)}</strong>
  </span>
{/if}

<div class="tr-view-stack tr-economic-view">
  <LiquidityRatesPanel rates={liquidityRates} {loading} />

  <section aria-labelledby="economic-indicators-title">
    <SectionHeading id="economic-indicators-title" title="宏观指标" />
  </section>

  {#if error}
    <div class="tr-economic-error" role="alert">
      <div>
        <strong>经济指标暂时无法加载</strong>
        <span>{error}</span>
      </div>
      <Button data-ui-owner="lib-trading-research-ResearchView-svelte" variant="outline" class={"ui-button"} type="button" onclick={loadIndicators}>重新加载</Button>
    </div>
  {/if}

  {#each groups as group, groupIndex}
    <ModuleCard
      class="tr-economic-group"
      style={`--tr-economic-accent: ${group.accent}`}
      labelledBy={`economic-group-${groupIndex}`}
    >
      <PanelHeading
        id={`economic-group-${groupIndex}`}
        title={group.type}
        accent={group.accent}
      />
      <div class="tr-economic-grid">
        {#each group.indicators as indicator (indicator.key)}
          <EconomicIndicatorCard
            {indicator}
            accent={group.accent}
            {loading}
          />
        {/each}
      </div>
    </ModuleCard>
  {/each}
</div>
