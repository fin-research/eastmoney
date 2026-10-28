<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLSelectAttributes } from "svelte/elements";

	type NativeSelectProps = Omit<WithElementRef<HTMLSelectAttributes>, "size"> & {
		size?: "sm" | "default";
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size = "default",
		children,
		...restProps
	}: NativeSelectProps = $props();
</script>

<select
  bind:value
  bind:this={ref}
  data-slot="native-select"
  data-size={size}
  class={cn("border-input bg-input/30 placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 h-9 w-full min-w-0 rounded-4xl border py-1 pr-8 pl-3 text-sm transition-colors select-none focus-visible:ring-[3px] aria-invalid:ring-[3px] data-[size=sm]:h-8 outline-none disabled:pointer-events-none disabled:cursor-not-allowed", className)}
  {...restProps}
>
  {@render children?.()}
</select>
