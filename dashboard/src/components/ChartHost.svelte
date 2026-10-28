<script lang="ts">
  import { onDestroy } from 'svelte';
  import { disposeChart, setChart, type ChartOption } from '../charts/charting';

  type ChartRenderer = (host: HTMLElement, ...args: any[]) => void;
  let { renderer = setChart, args = [], option, height, ariaLabel, className = 'chart-host', id }: {
    renderer?: ChartRenderer;
    args?: any[];
    option?: ChartOption;
    height?: number;
    ariaLabel: string;
    className?: string;
    id?: string;
  } = $props();
  let host: HTMLElement | undefined = $state();
  $effect(() => { if (host) renderer(host, ...(option ? [option] : args)); });
  onDestroy(() => { if (host) disposeChart(host); });
</script>

<div bind:this={host} {id} class={className} role="img" aria-label={ariaLabel}
  style:height={height === undefined ? undefined : `${height}rem`}></div>
