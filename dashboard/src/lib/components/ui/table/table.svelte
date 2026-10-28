<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLTableAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
    scrollable = true,
		...restProps
	}: WithElementRef<HTMLTableAttributes> & { scrollable?: boolean } = $props();
</script>

{#snippet content()}
  <table bind:this={ref} data-slot="table" class={cn("w-full caption-bottom text-sm", className)} {...restProps}>
    {@render children?.()}
  </table>
{/snippet}
{#if scrollable}
  <div data-slot="table-container" class="relative w-full overflow-x-auto">{@render content()}</div>
{:else}
  {@render content()}
{/if}
