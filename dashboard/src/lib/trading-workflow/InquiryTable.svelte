<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { onMount, tick, untrack } from 'svelte';
  import { fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { Plus } from '@lucide/svelte';
  import type { ShiborRate } from '../../data-contracts';
  import { blankInquiry, displayField, fieldError, hasInquiryValue, invalidField, previousValues, suggestions, type InquiryDirectory, type InquiryField, type InquiryRow } from './inquiries';
  let { rows, loan, directory, rates, date, now, onRows, onRemember }: {
    rows: InquiryRow[]; loan: boolean; directory: InquiryDirectory; rates: ShiborRate[]; date: string; now: Date;
    onRows: (rows: InquiryRow[]) => void; onRemember: (row: InquiryRow) => void;
  } = $props();
  type Cell = { id: string; field: InquiryField };
  const initial = (values: InquiryRow[]) => values.length ? values.map(row => ({ ...row })) : [blankInquiry()];
  let entries = $state<InquiryRow[]>(untrack(() => initial(rows)));
  let pending: string | null = null;
  let active = $state<Cell | null>(null);
  let selected = $state(0);
  let dismissed = $state(false);
  let composing = $state(false);
  let required = $state('');
  let touched = $state<Record<string, boolean>>({});
  let selection = $state<{ start: Cell; end: Cell } | null>(null);
  let drag: { cell: Cell; x: number; y: number } | null = null;
  let reducedMotion = $state(false);
  let root: HTMLDivElement;
  const fields = $derived<InquiryField[]>(loan ? ['counterparty', 'trader', 'tenor', 'amount', 'price'] : ['counterparty', 'tenor', 'amount', 'price']);
  const activeRow = $derived(entries.find(row => row.id === active?.id));
  const multiple = $derived(!!selection && (selection.start.id !== selection.end.id || selection.start.field !== selection.end.field));
  const options = $derived.by(() => {
    if (dismissed || multiple || !active || !activeRow) return [];
    if (active.field === 'counterparty' || active.field === 'trader') return suggestions(active.field === 'counterparty' ? directory.counterparties : directory.traders, activeRow[active.field]);
    return previousValues(entries, active.id, active.field).filter(value => !activeRow[active!.field].trim() || value.startsWith(activeRow[active!.field]));
  });
  const placeholders: Record<InquiryField, string> = { counterparty: '对手方', trader: '交易员', tenor: '期限', amount: '金额（亿）', price: '价格' };
  $effect(() => {
    const incoming = rows;
    untrack(() => {
      const fingerprint = JSON.stringify(incoming);
      if (pending !== null) { if (pending === fingerprint) pending = null; return; }
      if (!active && JSON.stringify(entries.filter(hasInquiryValue)) !== fingerprint) entries = initial(incoming);
    });
  });
  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => reducedMotion = media.matches; change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  });
  function publish(next: InquiryRow[]) {
    entries = next.length ? next : [blankInquiry()];
    const saved = entries.filter(hasInquiryValue);
    pending = JSON.stringify(saved); onRows(saved);
  }
  async function focus(id: string, field: InquiryField) {
    await tick(); root.querySelector<HTMLInputElement>(`[data-row="${id}"][data-field="${field}"]`)?.focus();
  }
  function update(row: InquiryRow, field: InquiryField, value: string) {
    const current = entries.find(item => item.id === row.id) ?? row;
    const next = { ...current, [field]: value };
    const index = entries.findIndex(item => item.id === row.id);
    const remove = hasInquiryValue(current) && !hasInquiryValue(next);
    publish(remove ? entries.filter(item => item.id !== row.id) : entries.map(item => item.id === row.id ? next : item));
    selection = null; required = ''; selected = 0; dismissed = !value.trim();
    if (remove) void focus(entries[Math.min(index, entries.length - 1)]!.id, field);
  }
  function error(row: InquiryRow, field: InquiryField) {
    return touched[`${row.id}:${field}`] ? fieldError(field, row[field]) ?? (required === `${row.id}:${field}` ? '请填写' + placeholders[field] : null) : null;
  }
  async function insert(id: string) {
    if (entries.length >= 500) return;
    const next = blankInquiry(), index = entries.findIndex(row => row.id === id);
    publish([...entries.slice(0, index + 1), next, ...entries.slice(index + 1)]);
    selection = null; await focus(next.id, fields[0]!);
  }
  async function finish(row: InquiryRow) {
    row = entries.find(item => item.id === row.id) ?? row;
    const field = invalidField(row, loan);
    if (field) { required = `${row.id}:${field}`; touched[required] = true; await focus(row.id, field); return; }
    onRemember(row);
    const next = entries[entries.findIndex(item => item.id === row.id) + 1];
    if (next) await focus(next.id, fields[0]!); else await insert(row.id);
  }
  function bounds() {
    if (!selection) return null;
    const a = entries.findIndex(row => row.id === selection!.start.id), b = entries.findIndex(row => row.id === selection!.end.id);
    const x = fields.indexOf(selection.start.field), y = fields.indexOf(selection.end.field);
    return { top: Math.min(a, b), bottom: Math.max(a, b), left: Math.min(x, y), right: Math.max(x, y) };
  }
  function inSelection(id: string, field: InquiryField) {
    const area = bounds(), r = entries.findIndex(row => row.id === id), c = fields.indexOf(field);
    return !!area && multiple && r >= area.top && r <= area.bottom && c >= area.left && c <= area.right;
  }
  async function clearSelection() {
    const area = bounds(); if (!area) return;
    const next = entries.map((row, r) => {
      if (r < area.top || r > area.bottom) return row;
      return Object.fromEntries(Object.entries(row).map(([field, value]) => [field, fields.indexOf(field as InquiryField) >= area.left && fields.indexOf(field as InquiryField) <= area.right ? '' : value])) as InquiryRow;
    }).filter(hasInquiryValue);
    publish(next); selection = null; dismissed = true;
    await focus(entries[Math.min(area.top, entries.length - 1)]!.id, fields[area.left]!); dismissed = true;
  }
  function copy(event: ClipboardEvent) {
    const area = bounds(); if (!multiple || !area || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', entries.slice(area.top, area.bottom + 1).map(row => fields.slice(area.left, area.right + 1).map(field => row[field]).join('\t')).join('\n'));
  }
  function pointerDown(event: PointerEvent, cell: Cell) {
    if (event.button !== 0) return;
    if (event.shiftKey && active) { event.preventDefault(); selection = { start: active, end: cell }; return; }
    selection = null; drag = { cell, x: event.clientX, y: event.clientY };
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    const input = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-row][data-field]')
      ?? (event.target as Element)?.closest<HTMLElement>('[data-row][data-field]');
    if (!input || !root.contains(input)) return;
    const end = { id: input.dataset.row!, field: input.dataset.field as InquiryField };
    selection = { start: drag.cell, end }; dismissed = true;
    if (multiple) { event.preventDefault(); window.getSelection()?.removeAllRanges(); }
  }
  async function key(event: KeyboardEvent, row: InquiryRow, field: InquiryField) {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape') { dismissed = true; selection = null; return; }
    if (event.shiftKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const start = selection?.start ?? { id: row.id, field }, end = selection?.end ?? start;
      const r = entries.findIndex(item => item.id === end.id), c = fields.indexOf(end.field);
      selection = { start, end: { id: entries[Math.max(0, Math.min(entries.length - 1, r + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)))]!.id,
        field: fields[Math.max(0, Math.min(fields.length - 1, c + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)))]! } }; dismissed = true; return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && multiple) { event.preventDefault(); await clearSelection(); return; }
    if ((event.key === 'Backspace' || event.key === 'Delete') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); selection = { start: { id: row.id, field: fields[0]! }, end: { id: row.id, field: fields.at(-1)! } }; await clearSelection(); return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
      event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length; return;
    }
    if (event.key !== 'Tab' && event.key !== 'Enter') return;
    selection = null;
    if (event.shiftKey) return;
    let next = entries.find(item => item.id === row.id) ?? row;
    if (options.length && active?.id === row.id && active.field === field) {
      next = { ...next, [field]: options[selected] ?? options[0]! }; update(next, field, next[field]); dismissed = true;
    }
    event.preventDefault(); touched[`${row.id}:${field}`] = true;
    if (fieldError(field, next[field])) return;
    if (field === 'price' || event.key === 'Enter') await finish(next);
    else await focus(row.id, fields[fields.indexOf(field) + 1]!);
  }
  function leave(row: InquiryRow, field: InquiryField) {
    const current = entries.find(item => item.id === row.id);
    touched[`${row.id}:${field}`] = true;
    if (current && (field === 'counterparty' || field === 'trader')) onRemember(current);
    if (active?.id === row.id && active.field === field) active = null;
  }
</script>

<svelte:window onpointermove={pointerMove} onpointerup={() => drag = null} onpointercancel={() => drag = null} onblur={() => drag = null} />
<div class="inquiry-table nodrag nopan nowheel" class:loan class:selecting={multiple} bind:this={root} role="table" aria-label="询价记录" oncopy={copy}>
  {#each entries as row (row.id)}
    <div class="inquiry-row" role="row" animate:flip={{ duration: reducedMotion ? 0 : 180 }} transition:fly={{ y: -6, duration: reducedMotion ? 0 : 180 }}>
      {#each fields as field}
        {@const message = error(row, field)}
        <div class="inquiry-cell" class:cell-selected={inSelection(row.id, field)} role="cell">
          <Input data-ui-owner="lib-trading-workflow-InquiryTable-svelte" class={"ui-input"} type="text" inputmode={field === 'amount' || field === 'price' ? 'decimal' : 'text'}
            data-row={row.id} data-field={field} aria-label={placeholders[field]} placeholder={field === 'amount' ? '金额/亿' : placeholders[field]}
            title={displayField(row, field, loan, rates, date, now) || undefined}
            maxlength={field === 'counterparty' ? 160 : field === 'trader' ? 80 : 24}
            role="combobox" aria-autocomplete="list" aria-expanded={active?.id === row.id && active.field === field && options.length > 0}
            aria-controls={`choices-${row.id}-${field}`}
            aria-activedescendant={active?.id === row.id && active.field === field && options.length ? `choice-${row.id}-${field}-${selected}` : undefined}
            aria-invalid={!!message} aria-describedby={message ? `error-${row.id}-${field}` : undefined} autocomplete="off" readonly={multiple}
            value={active?.id === row.id && active.field === field ? row[field] : displayField(row, field, loan, rates, date, now)}
            onpointerdown={event => pointerDown(event, { id: row.id, field })}
            ondragstart={event => event.preventDefault()}
            onfocus={event => { active = { id: row.id, field }; selected = 0; dismissed = false; event.currentTarget.value = row[field]; event.currentTarget.select(); }}
            onblur={() => leave(row, field)} oninput={event => update(row, field, event.currentTarget.value)}
            oncompositionstart={() => composing = true} oncompositionend={() => composing = false}
            onkeydown={event => void key(event, row, field)} />
          {#if message}<span class="cell-error" id={`error-${row.id}-${field}`} role="alert">{message}</span>{/if}
          {#if active?.id === row.id && active.field === field && options.length}
            <ul id={`choices-${row.id}-${field}`} class="inquiry-options" role="listbox" aria-label={placeholders[field]} transition:fly={{ y: -4, duration: reducedMotion ? 0 : 120 }}>
              {#each options as option, index}
                <li id={`choice-${row.id}-${field}-${index}`} role="option" aria-selected={index === selected}
                  onpointerdown={event => { event.preventDefault(); event.stopPropagation(); update(row, field, option); dismissed = true; void focus(row.id, field); }}>{option}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
      <button type="button" class="row-insert" aria-label="在此行下方插入询价" disabled={entries.length >= 500} onclick={() => void insert(row.id)}><span><Plus size={16} /></span></button>
    </div>
  {/each}
</div>

<style>
  .inquiry-table { padding: 6px 22px 22px 8px; background: white; border: 1px solid var(--tr-border, #dbe7f7); border-top: 0; border-radius: 0 0 8px 8px; }
  .inquiry-row { position: relative; display: grid; grid-template-columns: minmax(70px, 1.5fr) minmax(48px, .65fr) minmax(60px, .8fr) minmax(62px, .9fr); border-bottom: 1px solid var(--tr-border, #dbe7f7); }
  .loan .inquiry-row { grid-template-columns: minmax(70px, 1.4fr) minmax(54px, 1fr) minmax(48px, .65fr) minmax(60px, .8fr) minmax(62px, .9fr); }
  .inquiry-cell { position: relative; min-width: 0; transition: background-color 120ms; }
  .cell-selected { background: #dceaff; box-shadow: inset 0 0 0 1px #91b9ef; }
  .selecting { user-select: none; }
  :global(.inquiry-cell .ui-input[data-ui-owner="lib-trading-workflow-InquiryTable-svelte"]) { width: 100%; min-width: 0; height: 38px; padding-inline: 5px; font-size: .875rem; border: 0; border-radius: 0; background: transparent; box-shadow: none; font-weight: normal; }
  :global(.inquiry-cell .ui-input[data-ui-owner="lib-trading-workflow-InquiryTable-svelte"]:focus) { outline: 2px solid var(--brand, #2f6fd6); outline-offset: -2px; }
  :global(.inquiry-cell .ui-input[data-ui-owner="lib-trading-workflow-InquiryTable-svelte"][aria-invalid="true"]) { outline: 2px solid var(--color-error, #d92d20); outline-offset: -2px; }
  .cell-error { display: block; padding: 4px; color: var(--color-error, #d92d20); font-size: .75rem; }
  .inquiry-options { position: absolute; top: 100%; left: 0; z-index: 20; min-width: 120px; max-height: 240px; overflow: auto; margin: 0; padding: 4px; list-style: none; border: 1px solid var(--tr-border, #dbe7f7); border-radius: 6px; background: white; box-shadow: 0 4px 12px #17203318; }
  .inquiry-options li { padding: 8px; cursor: pointer; font-size: .875rem; }
  .inquiry-options li[aria-selected="true"] { background: #eaf2ff; }
  .row-insert { position: absolute; right: -22px; bottom: -22px; z-index: 5; width: 44px; height: 44px; display: grid; place-items: center; padding: 0; border: 0; background: transparent; cursor: pointer; }
  .row-insert span { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: white; border: 1px solid var(--brand, #2f6fd6); color: var(--brand, #2f6fd6); opacity: 0; transform: scale(.7); transition: opacity 160ms, transform 160ms; }
  .row-insert:hover span, .row-insert:focus-visible span { opacity: 1; transform: scale(1); }
  .row-insert:disabled { display: none; }
  @media (hover: none) { .row-insert span { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .inquiry-cell, .row-insert span { transition: none; } }
</style>
