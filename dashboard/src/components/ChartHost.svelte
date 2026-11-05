<script lang="ts">
  import { onDestroy } from 'svelte';
  import { disposeChart, getChart, setChart, type ChartOption } from '../charts/charting';

  type ChartRenderer = (host: HTMLElement, ...args: any[]) => void;
  let { renderer = setChart, args = [], option, height, ariaLabel, className = 'chart-host', id, onready }: {
    renderer?: ChartRenderer;
    args?: any[];
    option?: ChartOption;
    height?: number;
    ariaLabel: string;
    className?: string;
    id?: string;
    /** Called with the chart instance and its host after each render, to attach events once. */
    onready?: (chart: NonNullable<ReturnType<typeof getChart>>, host: HTMLElement) => void;
  } = $props();
  let host: HTMLElement | undefined = $state();
  $effect(() => {
    if (!host) return;
    renderer(host, ...(option ? [option] : args));
    const chart = getChart(host);
    if (chart) onready?.(chart, host);
  });
  onDestroy(() => { if (host) disposeChart(host); });
</script>

<div bind:this={host} {id} class={className} role="img" aria-label={ariaLabel}
  style:height={height === undefined ? undefined : `${height}rem`}></div>
