<script lang="ts">
  import ChartHost from "../../components/ChartHost.svelte";
  import { renderTimeline } from "../../charts/knowledge-graph";
  import type { KgDay } from "$lib/knowledge-graph";

  interface Props {
    days: readonly KgDay[];
    /** Inclusive day indexes of the chosen range. */
    from: number;
    to: number;
    /** Called when a drag or key press settles. */
    onchange: (from: number, to: number) => void;
  }

  let { days, from, to, onchange }: Props = $props();

  type Grip = "start" | "end" | "body";
  const COMMIT_DELAY = 220;

  let track: HTMLElement | undefined = $state();
  let drag = $state<{ grip: Grip; origin: number; from: number; to: number } | null>(null);
  let draftFrom = $state<number | null>(null);
  let draftTo = $state<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const count = $derived(days.length);
  const shownFrom = $derived(draftFrom ?? from);
  const shownTo = $derived(draftTo ?? to);
  const left = $derived((shownFrom / count) * 100);
  const width = $derived(((shownTo - shownFrom + 1) / count) * 100);
  const ticks = $derived(
    [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const index = Math.min(count - 1, Math.round(ratio * (count - 1)));
      return { index, label: days[index]?.date.slice(5) ?? "" };
    }),
  );

  function indexAt(clientX: number): number {
    if (!track) return 0;
    const box = track.getBoundingClientRect();
    const ratio = (clientX - box.left) / Math.max(1, box.width);
    return Math.max(0, Math.min(count - 1, Math.floor(ratio * count)));
  }

  function settle(): void {
    clearTimeout(timer);
    const nextFrom = draftFrom ?? from;
    const nextTo = draftTo ?? to;
    draftFrom = null;
    draftTo = null;
    if (nextFrom !== from || nextTo !== to) onchange(nextFrom, nextTo);
  }

  function propose(nextFrom: number, nextTo: number): void {
    draftFrom = Math.max(0, Math.min(nextFrom, nextTo));
    draftTo = Math.min(count - 1, Math.max(nextFrom, nextTo));
  }

  function press(event: PointerEvent, grip: Grip): void {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag = { grip, origin: indexAt(event.clientX), from: shownFrom, to: shownTo };
  }

  function move(event: PointerEvent): void {
    if (!drag) return;
    const index = indexAt(event.clientX);
    if (drag.grip === "start") propose(Math.min(index, drag.to), drag.to);
    else if (drag.grip === "end") propose(drag.from, Math.max(index, drag.from));
    else {
      const span = drag.to - drag.from;
      const shift = Math.max(-drag.from, Math.min(count - 1 - drag.to, index - drag.origin));
      propose(drag.from + shift, drag.from + shift + span);
      draftTo = (draftFrom ?? 0) + span;
    }
  }

  function release(): void {
    if (!drag) return;
    drag = null;
    settle();
  }

  function jump(event: PointerEvent): void {
    if ((event.target as Element).closest(".range-window")) return;
    const span = to - from;
    const start = Math.max(0, Math.min(count - 1 - span, indexAt(event.clientX) - Math.floor(span / 2)));
    onchange(start, start + span);
  }

  function key(event: KeyboardEvent, grip: Grip): void {
    const step = event.shiftKey ? 7 : 1;
    let delta = 0;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") delta = -step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") delta = step;
    else if (event.key === "Home") delta = -count;
    else if (event.key === "End") delta = count;
    else return;
    event.preventDefault();
    const baseFrom = draftFrom ?? from;
    const baseTo = draftTo ?? to;
    if (grip === "start") propose(Math.max(0, Math.min(baseTo, baseFrom + delta)), baseTo);
    else if (grip === "end") propose(baseFrom, Math.min(count - 1, Math.max(baseFrom, baseTo + delta)));
    else {
      const shift = Math.max(-baseFrom, Math.min(count - 1 - baseTo, delta));
      propose(baseFrom + shift, baseTo + shift);
    }
    clearTimeout(timer);
    timer = setTimeout(settle, COMMIT_DELAY);
  }

  const dateOf = (index: number): string => days[index]?.date ?? "";
</script>

<div class="range">
  <div class="range-track" bind:this={track} role="presentation" onpointerdown={jump}>
    <ChartHost renderer={renderTimeline} args={[days, { from: shownFrom, to: shownTo }]} ariaLabel="每日研报主张数" className="range-chart" />
    <div
      class="range-window"
      class:dragging={drag?.grip === "body"}
      style:left={`${left}%`}
      style:width={`${width}%`}
      role="group"
      aria-label="时间范围"
      tabindex="-1"
      onpointerdown={(event) => press(event, "body")}
      onpointermove={move}
      onpointerup={release}
      onpointercancel={release}
    >
      <span
        class="range-grip range-grip--start"
        role="slider"
        tabindex="0"
        aria-label="起始日"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={shownFrom}
        aria-valuetext={dateOf(shownFrom)}
        onpointerdown={(event) => { event.stopPropagation(); press(event, "start"); }}
        onpointermove={move}
        onpointerup={release}
        onpointercancel={release}
        onkeydown={(event) => key(event, "start")}
      ></span>
      <span
        class="range-grip range-grip--end"
        role="slider"
        tabindex="0"
        aria-label="结束日"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={shownTo}
        aria-valuetext={dateOf(shownTo)}
        onpointerdown={(event) => { event.stopPropagation(); press(event, "end"); }}
        onpointermove={move}
        onpointerup={release}
        onpointercancel={release}
        onkeydown={(event) => key(event, "end")}
      ></span>
    </div>
  </div>
  <div class="range-ticks" aria-hidden="true">
    {#each ticks as tick (tick.index)}
      <span style:left={`${((tick.index + 0.5) / count) * 100}%`}>{tick.label}</span>
    {/each}
  </div>
</div>

<style>
  .range {
    display: grid;
    gap: 4px;
    padding: 6px 28px 10px 16px;
    color: #e6edf7;
  }

  .range-track {
    position: relative;
    height: 64px;
    touch-action: none;
  }

  :global(.range-chart) {
    width: 100%;
    height: 100%;
  }

  .range-window {
    position: absolute;
    inset-block: 0;
    border: 1px solid #5b9dff;
    border-radius: 6px;
    background: rgba(91, 157, 255, 0.14);
    cursor: grab;
    touch-action: none;
  }

  .range-window.dragging {
    cursor: grabbing;
  }

  .range-grip {
    position: absolute;
    top: 50%;
    width: 22px;
    height: 44px;
    transform: translateY(-50%);
    cursor: ew-resize;
    touch-action: none;
  }

  .range-grip::after {
    content: "";
    position: absolute;
    inset-block: 8px;
    left: 8px;
    width: 6px;
    border-radius: 3px;
    background: #5b9dff;
    box-shadow: 0 0 10px rgba(91, 157, 255, 0.7);
  }

  .range-grip--start {
    left: -12px;
  }

  .range-grip--end {
    right: -12px;
  }

  .range-grip:focus-visible::after {
    background: #ffffff;
  }

  .range-grip:focus,
  .range-grip:focus-visible {
    outline: none !important;
  }

  .range-ticks {
    position: relative;
    height: 1.25rem;
    color: #8b9ab3;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .range-ticks span {
    position: absolute;
    transform: translateX(-50%);
    white-space: nowrap;
  }

  .range-ticks span:first-child {
    transform: none;
  }

  .range-ticks span:last-child {
    transform: translateX(-100%);
  }
</style>
