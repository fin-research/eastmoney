<script lang="ts">
  import { Card } from "$lib/components/ui/card/index.js";
  import type { Snippet } from "svelte";

  let {
    labelledBy,
    class: className = "",
    style = "",
    variant = "default",
    padding = "default",
    children,
  }: {
    labelledBy?: string;
    class?: string;
    style?: string;
    variant?: "default" | "report";
    padding?: "default" | "none";
    children: Snippet;
  } = $props();
</script>

<Card as="section" unstyled={variant === "report"}
  class={["module-card tr-panel block overflow-visible text-base ring-0", variant === "report" && "module-card--report", padding === "none" && "module-card--flush", className]}
  aria-labelledby={labelledBy}
  {style}
>
  {@render children()}
</Card>

<style>
  :global(.module-card) {
    display: block;
    min-width: 0;
    padding: 18px;
    border: 1px solid var(--tr-border, var(--border-color, #d8e2f0));
    border-radius: var(--tr-radius-card, var(--radius-card, 10px));
    color: var(--tr-text, var(--text-1, #172033));
    background: var(--tr-surface, var(--surface, #ffffff));
    box-shadow: var(
      --tr-shadow,
      var(--shadow-card, 0 2px 8px rgba(23, 32, 51, 0.06))
    );
  }

  :global(.module-card--report) {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  @media (max-width: 720px) {
    :global(.module-card) {
    display: block;
      padding: 15px;
    }

    :global(.module-card--report) {
      padding: 0;
    }
  }

  :global(.module-card--flush) {
    padding: 0;
  }
</style>
