<script lang="ts">
  import type { CreditSession } from "./types";

  let { session, sending = false }: { session: CreditSession; sending?: boolean } = $props();
</script>

<div class="credit-activity" role="status" aria-live="polite">
  <span class="ui-spinner" aria-hidden="true"></span>
  <span>{sending ? "正在发送" : session.progress || "正在处理"}</span>
</div>

<style>
  .credit-activity { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; color: var(--text-1); font-size: .875rem; }
  .ui-spinner { color: var(--brand); flex-shrink: 0; }
  @media (prefers-reduced-motion: reduce) { .ui-spinner { animation: none; } }
</style>
