<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { ChevronDown } from '@lucide/svelte';
  let { label, options, values = $bindable([]), allLabel = '全部', optionLabels = {} }: {
    label: string; options: string[]; values: string[]; allLabel?: string; optionLabels?: Record<string, string>;
  } = $props();
  const summary = $derived(values.length === 0 ? allLabel : values.length === 1 ? optionLabels[values[0]!] ?? values[0] : `已选 ${values.length} 项`);
  function toggle(option: string) { values = values.includes(option) ? values.filter(value => value !== option) : [...values, option]; }
</script>

<div class="multi-filter">
  <span class="filter-label">{label}</span>
  <Popover.Root>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="outline" class="min-w-28 justify-between" aria-label={`${label}：${summary}`}><span>{summary}</span><ChevronDown size={16} aria-hidden="true" /></Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content role="dialog" align="start" class="grid gap-1 p-2 w-56 max-h-[60dvh] overflow-y-auto" aria-label={label}>
      <Button variant="ghost" class="justify-start" aria-pressed={values.length === 0} onclick={() => values = []}>{allLabel}</Button>
      {#each options as option}
        <label class="filter-option"><Checkbox checked={values.includes(option)} onCheckedChange={() => toggle(option)} aria-label={optionLabels[option] ?? option} /><span>{optionLabels[option] ?? option}</span></label>
      {/each}
    </Popover.Content>
  </Popover.Root>
</div>

<style>
  .multi-filter { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .filter-label { font-size: .875rem; color: var(--text-muted); white-space: nowrap; }
  .filter-option { display: flex; gap: .75rem; align-items: center; min-height: 44px; padding: .5rem; border-radius: .75rem; cursor: pointer; }
  .filter-option:hover { background: var(--brand-soft); }
  @media (max-width: 820px) { .multi-filter { flex-direction: column; align-items: stretch; gap: .375rem; } }
</style>
