<script lang="ts">
  import { Badge as PrimitiveBadge } from "$lib/components/ui/badge/index.js";
  import type { Snippet } from "svelte";

  let {
    tone = "neutral",
    children,
  }: {
    tone?: "info" | "success" | "warning" | "neutral";
    children: Snippet;
  } = $props();
</script>

<PrimitiveBadge variant="secondary" class={`tr-badge tr-badge--${tone}`}>{@render children()}</PrimitiveBadge>
