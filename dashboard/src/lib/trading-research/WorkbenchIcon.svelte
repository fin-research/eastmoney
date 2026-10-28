<script lang="ts">
  import type { WorkbenchIconName } from "./demo-data";

  let { name, className = "" }: { name: WorkbenchIconName; className?: string } =
    $props();
</script>

<svg
  class={`tr-workbench-icon${className ? ` ${className}` : ""}`}
  viewBox="0 0 24 24"
  aria-hidden="true"
>
  {#if name === "overview"}
    <rect x="3" y="3" width="7" height="7" rx="2" />
    <rect x="14" y="3" width="7" height="7" rx="2" />
    <rect x="3" y="14" width="7" height="7" rx="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" />
  {:else if name === "trading"}
    <path d="M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3" />
  {:else if name === "credit"}
    <path d="M12 3 5 6v5c0 4.8 2.7 8.4 7 10 4.3-1.6 7-5.2 7-10V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  {:else if name === "market-hotspots"}
    <circle cx="6" cy="12" r="2.5" /><circle cx="17" cy="6" r="2.5" /><circle cx="18" cy="17" r="2.5" />
    <path d="m8.3 10.8 6.4-3.6M8.4 13.1l7.2 2.8" />
  {:else if name === "policy-tracking"}
    <path d="M6 3v18M6 5h12l-3 4 3 4H6" />
  {:else if name === "tracking-commentary"}
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5" />
  {:else if name === "research"}
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" />
  {:else if name === "workflow"}
    <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
    <path d="M8.5 9h7M8.5 13h5M8.5 17h3" />
  {:else if name === "bond" || name === "secondary-bond-pool"}
    <path d="M4 4h16v16H4zM8 16v-4m4 4V8m4 8v-6" />
  {:else if name === "financing-model"}
    <path d="M4 19V9m5 10V5m5 14v-7m5 7V8M3 21h18" />
  {:else if name === "calendar"}
    <path d="M4 6.5h16M7 3v3M17 3v3M5 4h14v17H5z" />
  {:else if name === "check"}
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 2.5 2.5L16 9" />
  {:else if name === "database"}
    <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
    <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
  {:else if name === "funds"}
    <path d="M4 19V9m5 10V5m5 14v-7m5 7V8M3 21h18" />
  {:else if name === "menu"}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === "user"}
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
  {:else if name === "search"}
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4 4" />
  {:else if name === "sidebar"}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  {:else if name === "chat"}
    <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z" />
    <path d="M7 10h8M7 14h5" />
  {:else if name === "plus"}
    <path d="M12 5v14M5 12h14" />
  {:else if name === "arrow-up"}
    <path d="M12 19V5m-6 6 6-6 6 6" />
  {:else if name === "file"}
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5" />
  {:else if name === "download"}
    <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
  {:else if name === "copy"}
    <rect x="8" y="8" width="12" height="13" rx="2" />
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
  {:else if name === "warning"}
    <path d="M12 3 2.8 20h18.4L12 3Z" />
    <path d="M12 9v5m0 3h.01" />
  {/if}
</svg>
