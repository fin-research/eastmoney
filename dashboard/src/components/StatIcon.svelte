<script lang="ts">
  import type { StatIconName } from "../view-model";

  interface Props {
    icon: StatIconName;
  }

  let { icon }: Props = $props();
</script>

<svg
  class={`stat-icon stat-icon--${icon}`}
  viewBox="0 0 32 32"
  aria-hidden="true"
  focusable="false"
>
  {#if icon === "turnover"}
    <path d="M6 9.5h20v15H6z" />
    <path d="M10 9.5V6.8h12v2.7" />
    <path d="M10 16h12M10 20h7" />
  {:else}
    <path d="M7 24.5V15m6 9.5V9m6 15.5V12m6 12.5V5.5" />
    <path d="M5 25h22" />
    <path d="m8.5 7.5 4-4 4 2.5 6-7" />
  {/if}
</svg>

