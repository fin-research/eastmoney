<script lang="ts">
  import { Switch as SwitchPrimitive } from "bits-ui";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
  let { ref = $bindable(null), checked = $bindable(false), class: className, ...restProps }: WithoutChildrenOrChild<SwitchPrimitive.RootProps> = $props();
</script>

<SwitchPrimitive.Root bind:ref bind:checked data-slot="switch" class={cn("peer relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-input bg-input transition-colors data-checked:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none disabled:cursor-not-allowed disabled:opacity-50 after:absolute after:-inset-y-2.5", className)} {...restProps}>
  <SwitchPrimitive.Thumb data-slot="switch-thumb" class="pointer-events-none block size-5 rounded-full bg-background shadow-sm transition-transform translate-x-0.5 data-checked:translate-x-5 motion-reduce:transition-none" />
</SwitchPrimitive.Root>
