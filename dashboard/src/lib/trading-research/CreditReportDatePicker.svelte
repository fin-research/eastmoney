<script lang="ts">
  import { Calendar } from 'bits-ui';
  import { parseDate } from '@internationalized/date';
  import { CalendarDays, ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { creditQuarterDates } from '../credit/report-date.ts';

  let { value, min, disabled = false, onchange }: { value: string; min?: string; disabled?: boolean; onchange: (date: string) => void } = $props();
  let open = $state(false);
  let year = $state(0);
  const quarters = $derived(creditQuarterDates(year, min));
  function select(date: string) { open = false; onchange(date); }
</script>

<div class="tr-credit-report-date">
  <span>报告日</span>
  <Popover.Root bind:open onOpenChange={next => { if (next) year = Number(value.slice(0, 4)); }}>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} {disabled} variant="outline" aria-label={`报告日：${value}`}><CalendarDays size={16} aria-hidden="true" />{value}</Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content role="dialog" aria-label="选择报告日" align="start" class="credit-report-date-popover">
      <Calendar.Root type="single" value={parseDate(value)} minValue={min ? parseDate(min) : undefined}
        locale="zh-CN" weekStartsOn={1} preventDeselect calendarLabel="报告日" onValueChange={date => { if (date) select(date.toString()); }}>
        {#snippet children({ months, weekdays })}
          <Calendar.Header class="credit-date-nav">
            <Calendar.PrevButton aria-label="上一个月"><ChevronLeft size={16} aria-hidden="true" /></Calendar.PrevButton>
            <Calendar.Heading />
            <Calendar.NextButton aria-label="下一个月"><ChevronRight size={16} aria-hidden="true" /></Calendar.NextButton>
          </Calendar.Header>
          {#each months as month}
            <Calendar.Grid>
              <Calendar.GridHead><Calendar.GridRow>
                {#each weekdays as weekday}<Calendar.HeadCell>{weekday}</Calendar.HeadCell>{/each}
              </Calendar.GridRow></Calendar.GridHead>
              <Calendar.GridBody>
                {#each month.weeks as week}<Calendar.GridRow>
                  {#each week as date}<Calendar.Cell {date} month={month.value}><Calendar.Day /></Calendar.Cell>{/each}
                </Calendar.GridRow>{/each}
              </Calendar.GridBody>
            </Calendar.Grid>
          {/each}
        {/snippet}
      </Calendar.Root>
      <div class="credit-quarter-dates">
        <div class="credit-date-nav">
          <Button variant="ghost" size="icon" aria-label="上一年" disabled={!!min && year <= Number(min.slice(0,4))} onclick={() => year--}><ChevronLeft size={16} aria-hidden="true" /></Button>
          <strong>{year}</strong>
          <Button variant="ghost" size="icon" aria-label="下一年" onclick={() => year++}><ChevronRight size={16} aria-hidden="true" /></Button>
        </div>
        {#each quarters as quarter}
          <Button variant={value === quarter.date ? 'default' : 'outline'} aria-pressed={value === quarter.date} onclick={() => select(quarter.date)}>{quarter.label}</Button>
        {/each}
      </div>
    </Popover.Content>
  </Popover.Root>
</div>

<style>
  .tr-credit-report-date { display: flex; align-items: center; gap: 8px; }
  :global(.credit-report-date-popover) { display: grid; grid-template-columns: minmax(0, 1fr) 8rem; width: min(30rem, calc(100vw - 1rem)); max-height: calc(100dvh - 6rem); overflow-y: auto; gap: 12px; }
  .credit-quarter-dates { display: flex; flex-direction: column; gap: 8px; border-left: 1px solid var(--border); padding-left: 12px; }
  :global(.credit-report-date-popover .credit-date-nav) { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  :global(.credit-report-date-popover [data-calendar-grid]) { width: 100%; border-collapse: collapse; }
  :global(.credit-report-date-popover [data-calendar-head-cell]) { font-weight: normal; color: var(--muted-foreground); }
  :global(.credit-report-date-popover [data-calendar-cell]) { padding: 0; text-align: center; }
  :global(.credit-report-date-popover [data-calendar-day]) { display: flex; align-items: center; justify-content: center; min-height: 44px; border-radius: var(--radius); cursor: pointer; }
  :global(.credit-report-date-popover [data-calendar-day]:hover) { background: var(--accent); }
  :global(.credit-report-date-popover [data-calendar-day][data-selected]) { background: var(--primary); color: var(--primary-foreground); }
  :global(.credit-report-date-popover [data-calendar-day][data-outside-month]), :global(.credit-report-date-popover [data-disabled]) { opacity: .4; }
  :global(.credit-report-date-popover [data-calendar-day][data-disabled]) { cursor: default; }
  :global(.credit-report-date-popover [data-calendar-prev-button]), :global(.credit-report-date-popover [data-calendar-next-button]) { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--radius); }
  :global(.credit-report-date-popover [data-calendar-day]:focus-visible), :global(.credit-report-date-popover button:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
  @media (max-width: 480px) {
    :global(.credit-report-date-popover) { grid-template-columns: minmax(0, 1fr) 6rem; padding: 8px; gap: 8px; }
    .credit-quarter-dates { padding-left: 8px; }
    .credit-quarter-dates :global(button) { min-width: 0; padding-inline: 4px; }
    .credit-quarter-dates :global(.credit-date-nav) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .credit-quarter-dates strong { grid-column: 1 / -1; grid-row: 1; display: flex; align-items: center; justify-content: center; min-height: 44px; }
  }
</style>
