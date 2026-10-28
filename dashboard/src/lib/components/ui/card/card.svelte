<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
    as = "div",
    unstyled = false,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>, HTMLElement> & { size?: "default" | "sm"; as?: "div" | "section" | "article"; unstyled?: boolean } = $props();
</script>

<svelte:element this={as}
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn(!unstyled && "ring-foreground/10 bg-card text-card-foreground gap-(--card-spacing) overflow-hidden rounded-2xl py-(--card-spacing) text-sm ring-1 [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col", className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
