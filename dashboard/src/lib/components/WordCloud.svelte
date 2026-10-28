<script lang="ts">

  import { Button } from "$lib/components/ui/button/index.js";
  import cloud from "d3-cloud";
  import { onDestroy, onMount } from "svelte";

  import type { Hotspot } from "$lib/hotspots";

  interface CloudWord extends Hotspot {
    text: string;
    size: number;
    x?: number;
    y?: number;
    rotate?: number;
  }

  interface Props {
    items?: Hotspot[];
    selectedKeyword?: string;
    onSelect: (hotspot: Hotspot) => void;
  }

  let { items = [], selectedKeyword = "", onSelect }: Props = $props();

  let host = $state<HTMLDivElement>(null!);
  let observer: ResizeObserver | null = null;
  let layout: ReturnType<typeof cloud<CloudWord>> | null = null;
  let placedWords = $state<CloudWord[]>([]);
  let width = $state(1);
  let height = $state(1);
  let mounted = $state(false);
  let layoutGeneration = 0;
  let useListFallback = $state(false);
  let lastSignature = $state("");
  let frame: number | null = null;

  const colors = ["var(--color-warning-content)", "var(--brand-deep)", "var(--color-success-content)", "var(--business-purple)", "var(--color-error-content)"];

  onMount(() => {
    mounted = true;
    observer = new ResizeObserver(() => scheduleLayout());
    observer.observe(host);
    scheduleLayout();
  });

  onDestroy(() => {
    mounted = false;
    layoutGeneration += 1;
    observer?.disconnect();
    layout?.stop();
    if (frame !== null) cancelAnimationFrame(frame);
  });


  function scheduleLayout(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      runLayout();
    });
  }

  function runLayout(): void {
    const generation = ++layoutGeneration;
    useListFallback = false;
    const bounds = host.getBoundingClientRect();
    width = Math.max(280, Math.floor(bounds.width));
    height = Math.max(260, Math.floor(bounds.height));
    if (items.length === 0) {
      placedWords = [];
      return;
    }
    layout?.stop();
    const minimumHeat = Math.min(...items.map((item) => item.heat));
    const maximumHeat = Math.max(...items.map((item) => item.heat));
    const minimumSize = clamp(Math.min(width, height) / 18, 28, 46);
    const maximumSize = clamp(Math.min(width, height) / 6.2, 66, 132);
    const heatRange = Math.max(1, maximumHeat - minimumHeat);
    const words: CloudWord[] = items.map((item) => {
      const desiredSize =
        minimumSize +
        ((item.heat - minimumHeat) / heatRange) * (maximumSize - minimumSize);
      const widthBoundSize = (width * 0.86) / textWidthUnits(item.keyword);
      return {
        ...item,
        text: item.keyword,
        size: Math.max(20, Math.min(desiredSize, widthBoundSize)),
      };
    });

    function placeWords(attempt = 0): void {
      layout?.stop();
      const scale = 0.85 ** attempt;
      layout = cloud<CloudWord>()
      .size([width, height])
      .words(words.map((word) => ({ ...word, size: Math.max(18, word.size * scale) })))
      .padding(() => clamp(width / 120, 5, 13))
      .rotate(0)
      .font(getComputedStyle(host).fontFamily)
      .fontWeight((word) => (word.heat >= 75 ? "bold" : "normal"))
      .fontSize((word) => word.size)
      .spiral("archimedean")
      .random(seededRandom(`${width}:${height}:${lastSignature}`))
      .on("end", (result) => {
        if (!mounted || generation !== layoutGeneration) return;
        if (result.length < words.length && attempt < 7) {
          placeWords(attempt + 1);
          return;
        }
        useListFallback = result.length < words.length;
        placedWords = result;
      });
      layout.start();
    }
    placeWords();
  }

  function selectWord(word: CloudWord): void {
    onSelect(word);
  }

  function handleKeydown(event: KeyboardEvent, word: CloudWord): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectWord(word);
  }

  function wordColor(index: number, word: CloudWord): string {
    if (word.heat >= 85) return colors[0]!;
    return colors[(index % (colors.length - 1)) + 1]!;
  }

  function seededRandom(seedText: string): () => number {
    let seed = 2_166_136_261;
    for (const character of seedText) {
      seed ^= character.charCodeAt(0);
      seed = Math.imul(seed, 16_777_619);
    }
    return () => {
      seed = Math.imul(seed, 1_664_525) + 1_013_904_223;
      return (seed >>> 0) / 4_294_967_296;
    };
  }

  function textWidthUnits(value: string): number {
    return [...value].reduce(
      (total, character) => total + (/^[\x00-\x7F]$/.test(character) ? 0.62 : 1),
      0,
    );
  }

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }
  $effect(() => {
    if (mounted) {
      const signature = items.map((item) => `${item.keyword}:${item.heat}`).join("|");
      if (signature !== lastSignature) {
        lastSignature = signature;
        scheduleLayout();
      }
    }
  });
</script>

<div bind:this={host} class="cloud-host" aria-label="当日市场热点词云">
  {#if useListFallback}
    <div class="cloud-list" aria-label="完整热点列表">
      {#each items as word, index (word.keyword)}
        <Button data-ui-owner="lib-components-WordCloud-svelte" variant="ghost" class={"ui-button "} type="button" aria-pressed={selectedKeyword === word.keyword}
          aria-label={`${word.keyword}，热度 ${word.heat}`} onclick={() => onSelect(word)}>
          <strong style:color={wordColor(index, { ...word, text: word.keyword, size: 18 })}>{word.keyword}</strong>
          <span>热度 {word.heat}</span>
        </Button>
      {/each}
    </div>
  {:else if placedWords.length === 0}
    <div class="cloud-layout-status" role="status">正在排布热点词云…</div>
  {:else}
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label="热点词云"
      preserveAspectRatio="xMidYMid meet"
    >
      <g transform={`translate(${width / 2} ${height / 2})`}>
        {#each placedWords as word, index (word.keyword)}
          <g
            class:selected={selectedKeyword === word.keyword}
            class="cloud-word"
            role="button"
            aria-pressed={selectedKeyword === word.keyword}
            tabindex="0"
            aria-label={`${word.keyword}，热度 ${word.heat}`}
            transform={`translate(${word.x ?? 0} ${word.y ?? 0}) rotate(${word.rotate ?? 0})`}
            onclick={() => selectWord(word)}
            onkeydown={(event) => handleKeydown(event, word)}
          >
            <title>{word.keyword} · 热度 {word.heat}</title>
            <text
              text-anchor="middle"
              dominant-baseline="central"
              font-size={word.size}
              font-weight={word.heat >= 75 ? "bold" : "normal"}
              fill={wordColor(index, word)}
            >{word.text}</text>
          </g>
        {/each}
      </g>
    </svg>
  {/if}
</div>

<style>
  .cloud-host {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 260px;
    overflow: hidden;
  }

  .cloud-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); align-content: start; gap: 12px; height: 100%; padding: 8px; overflow-y: auto; }
  :global(.cloud-list button[data-ui-owner="lib-components-WordCloud-svelte"]) { display: grid; justify-items: start; min-height: 64px; white-space: normal; text-align: left; }
  .cloud-list strong { min-width: 0; font-size: 1rem; overflow-wrap: anywhere; }
  .cloud-list span { color: var(--text-3); font-size: .875rem; font-weight: normal; }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .cloud-word {
    cursor: pointer;
    outline: none;
  }

  .cloud-word text {
    paint-order: stroke;
    stroke: transparent;
    stroke-width: 1.5px;
    transition:
      opacity 160ms ease,
      stroke 160ms ease;
  }

  .cloud-word:hover text {
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 6px;
    opacity: 1;
  }

  .cloud-word.selected text {
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 6px;
  }

  .cloud-word:focus-visible text {
    stroke: var(--brand-deep);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 6px;
  }

  .cloud-layout-status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-3);
    font-size: 0.875rem;
    letter-spacing: 0.08em;
  }

  @media (prefers-reduced-motion: reduce) {
    .cloud-word text {
      transition: none;
    }
  }
</style>
