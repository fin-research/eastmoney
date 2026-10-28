<script lang="ts">
  import type { MetricIconName } from "../view-model";

  interface Props {
    icon: MetricIconName;
  }

  let { icon }: Props = $props();
</script>

<svg
  class={`metric-icon metric-icon--${icon}`}
  viewBox="0 0 32 32"
  aria-hidden="true"
  focusable="false"
>
  {#if icon === "bank"}
    <path d="M4 11.5 16 5l12 6.5" />
    <path d="M6.5 12.5h19M5 27h22M8 24V14m5.3 10V14m5.4 10V14M24 24V14" />
  {:else if icon === "liquidity"}
    <path d="M16 4.5c4.8 6.2 8 10.2 8 14.3a8 8 0 0 1-16 0C8 14.7 11.2 10.7 16 4.5Z" />
    <path d="M11.5 19.5c.5 2.3 2.1 3.6 4.5 3.9" />
  {:else if icon === "bond"}
    <circle cx="16" cy="16" r="11.5" />
    <path d="M16 8.5v15M11.5 12h6.8a2.8 2.8 0 0 1 0 5.6h-4.6a2.8 2.8 0 0 0 0 5.6h6.8" />
  {:else if icon === "equity"}
    <line x1="5" y1="26" x2="27" y2="26" />
    <path d="M7 22v-5h4v5m3 0V12h4v10m3 0V8h4v14M7 13l6-5 4 2.5 8-6" />
  {:else if icon === "issuance"}
    <path d="M7 6h18v20H7zM11 11h10M11 16h10M11 21h6" />
    <circle cx="22.5" cy="22.5" r="5" />
    <path d="M22.5 19.5v6M20.5 21h3.2a1.2 1.2 0 0 1 0 2.4h-2.4" />
  {:else if icon === "leverage"}
    <path d="M6 24h20M16 7v17M9 11h14" />
    <path d="m9 11-4 7h8zm14 0-4 7h8z" />
  {:else if icon === "profit"}
    <path d="M7 10.5h18v15H7zM10 10.5V7h12v3.5" />
    <path d="M12 18h8m-4-4v8" />
  {:else}
    <path d="M6 11h17m0 0-4-4m4 4-4 4M26 21H9m0 0 4-4m-4 4 4 4" />
  {/if}
</svg>
