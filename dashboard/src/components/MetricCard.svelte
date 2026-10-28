<script lang="ts">
  import { Card } from "$lib/components/ui/card/index.js";
  import type { Component, Snippet } from "svelte";

  type MetricTone =
    | "primary"
    | "blue"
    | "cyan"
    | "teal"
    | "green"
    | "orange"
    | "purple"
    | "red"
    | "good"
    | "bad"
    | "neutral";

  let {
    label,
    value,
    unit = "",
    detail,
    detailPrefix = "",
    detailSuffix = "",
    detailTone = "",
    neutralDetail = false,
    details,
    tone = "primary",
    iconComponent: IconComponent,
    iconProps = {},
    iconPosition = "start",
    compact = false,
    smallIcon = false,
    variant = "default",
  }: {
    label: string;
    value: string;
    unit?: string;
    detail?: string;
    detailPrefix?: string;
    detailSuffix?: string;
    detailTone?: string;
    neutralDetail?: boolean;
    details?: Snippet;
    tone?: MetricTone;
    iconComponent?: Component<any>;
    iconProps?: Record<string, unknown>;
    iconPosition?: "start" | "end";
    compact?: boolean;
    smallIcon?: boolean;
    variant?: "default" | "report";
  } = $props();
</script>

<Card as="article" unstyled={variant === "report"}
  class={[
    `research-metric-card research-metric-card--${tone} ring-0 overflow-visible`,
    compact && "research-metric-card--compact",
    smallIcon && "research-metric-card--small-icon",
    variant === "report" && "research-metric-card--report",
    Boolean(IconComponent) && iconPosition === "end" && "research-metric-card--icon-end"
  ]}
>
  {#if IconComponent && iconPosition === "start"}
    <span class="research-metric-card__icon" aria-hidden="true">
      <IconComponent {...iconProps} />
    </span>
  {/if}

  <div class="research-metric-card__content">
    <span class="research-metric-card__label">{label}</span>
    <div class="research-metric-card__value">
      <strong>{value}</strong>
      {#if unit}<span>{unit}</span>{/if}
    </div>
    {#if details}
      <div class="research-metric-card__detail" class:research-metric-card__detail--neutral={neutralDetail}>{@render details()}</div>
    {:else if detail !== undefined && detail !== ""}
      <p class="research-metric-card__detail" class:research-metric-card__detail--neutral={neutralDetail}>
        {detailPrefix}{#if detailTone}<b class={detailTone}>{detail}</b>{:else}<span
            >{detail}</span
          >{/if}{detailSuffix}
      </p>
    {/if}
  </div>

  {#if IconComponent && iconPosition === "end"}
    <span class="research-metric-card__icon" aria-hidden="true">
      <IconComponent {...iconProps} />
    </span>
  {/if}
</Card>

<style>
  :global(.research-metric-card) {
    --metric-accent: var(--color-primary, #2f6fd6);
    --metric-soft: var(--color-primary-soft, #eaf1fd);
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    align-items: center;
    justify-content: space-evenly;
    gap: 8px;
    padding: 8px clamp(8px, 0.8vw, 14px);
    border: 1px solid var(--border-color, #d8e2f0);
    border-radius: var(--radius-card, 10px);
    color: var(--text-1, #172033);
    background: color-mix(in srgb, var(--metric-accent) 5%, var(--bg-card, #ffffff));
    box-shadow: var(--shadow-card, 0 2px 8px rgba(23, 32, 51, 0.06));
  }

  :global(.research-metric-card--icon-end) {
    flex-direction: row;
  }

  :global(.research-metric-card--compact) {
    justify-content: flex-start;
    padding-block: 6px;
  }

  :global(.research-metric-card--small-icon) .research-metric-card__icon,
  :global(.research-metric-card--small-icon) .research-metric-card__icon :global(svg) {
    width: 2.5rem;
    height: 2.5rem;
  }

  :global(.research-metric-card--small-icon) .research-metric-card__icon {
    flex-basis: 2.5rem;
  }

  :global(.research-metric-card--report) {
    --metric-report-background: #f8fafc;
    min-height: 78px;
    align-items: stretch;
    justify-content: flex-start;
    gap: 0;
    padding: 10px 12px;
    border-color: #cbd5e1;
    border-top: 4px solid var(--metric-accent);
    border-radius: 5px;
    background: var(--metric-report-background);
    box-shadow: none;
  }

  :global(.research-metric-card--report.research-metric-card--cyan) {
    --metric-accent: #0284c7;
    --metric-report-background: #eff6ff;
  }

  :global(.research-metric-card--report) .research-metric-card__content {
    justify-content: flex-start;
  }

  :global(.research-metric-card--report) .research-metric-card__label {
    font-size: 0.6875rem;
  }

  :global(.research-metric-card--report) .research-metric-card__value strong {
    color: #0f3d6c;
    font-size: 1.125rem;
    line-height: 1.45;
  }

  :global(.research-metric-card--report) .research-metric-card__detail {
    color: #64748b;
    font-size: 0.65625rem;
    line-height: 1.35;
  }

  :global(.research-metric-card--blue),
  :global(.research-metric-card--primary) {
    --metric-accent: #2f6fd6;
    --metric-soft: #eaf1fd;
  }

  :global(.research-metric-card--cyan) {
    --metric-accent: #277b91;
    --metric-soft: #e9f5f8;
  }

  :global(.research-metric-card--teal),
  :global(.research-metric-card--green),
  :global(.research-metric-card--good) {
    --metric-accent: #12a873;
    --metric-soft: #e7f6f0;
  }

  :global(.research-metric-card--orange) {
    --metric-accent: #c66a23;
    --metric-soft: #fff1e7;
  }

  :global(.research-metric-card--purple) {
    --metric-accent: #6f63c6;
    --metric-soft: #efedfb;
  }

  :global(.research-metric-card--red),
  :global(.research-metric-card--bad) {
    --metric-accent: #d92d20;
    --metric-soft: #fceceb;
  }

  :global(.research-metric-card--neutral) {
    --metric-accent: #667085;
    --metric-soft: #f2f4f7;
  }

  .research-metric-card__content {
    display: flex;
    min-width: 0;
    flex: 1;
    justify-content: center;
    flex-direction: column;
  }

  .research-metric-card__label {
    color: var(--text-3, #667085);
    font-size: 1rem;
    font-weight: bold;
    line-height: 1.2;
  }

  .research-metric-card__value {
    display: flex;
    min-width: 0;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 6px;
    font-variant-numeric: tabular-nums;
  }

  .research-metric-card__value strong {
    min-width: 0;
    color: var(--text-1, #172033);
    font-size: 1.5rem;
    font-weight: bolder;
    letter-spacing: -0.025em;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .research-metric-card__value span {
    color: var(--text-3, #667085);
    font-size: 1rem;
  }

  .research-metric-card__detail {
    margin: 0;
    color: var(--metric-accent);
    font-size: 1rem;
    font-weight: normal;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .research-metric-card__detail--neutral {
    color: var(--text-1, #172033);
  }

  .research-metric-card__detail b {
    font-weight: bold;
  }

  .research-metric-card__detail :global(.tone-inject) {
    color: #12805c;
  }

  .research-metric-card__detail :global(.tone-withdraw) {
    color: #d92d20;
  }

  .research-metric-card__icon {
    display: grid;
    width: 3rem;
    height: 3rem;
    flex: 0 0 3rem;
    place-items: center;
    border-radius: 50%;
    color: var(--metric-accent);
    background: var(--metric-soft);
  }

  .research-metric-card__icon :global(svg) {
    width: 3rem;
    height: 3rem;
    padding: 0;
    color: inherit;
    background: transparent;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2.5;
  }

  @media (max-width: 900px) {
    :global(.research-metric-card) {
      min-height: 82px;
      justify-content: flex-start;
      padding: 8px;
    }

    .research-metric-card__icon,
    .research-metric-card__icon :global(svg) {
      width: 2.5rem;
      height: 2.5rem;
    }

    .research-metric-card__icon {
      flex-basis: 2.5rem;
    }

    .research-metric-card__label,
    .research-metric-card__detail,
    .research-metric-card__value span {
      font-size: 0.875rem;
    }

    .research-metric-card__value strong {
      font-size: 1.25rem;
    }
  }

  @media (max-width: 420px) {
    :global(.research-metric-card) {
      min-height: 78px;
      gap: 6px;
      padding: 7px 6px;
    }

    .research-metric-card__icon,
    .research-metric-card__icon :global(svg) {
      width: 2.25rem;
      height: 2.25rem;
    }

    .research-metric-card__icon {
      flex-basis: 2.25rem;
    }

    .research-metric-card__label,
    .research-metric-card__detail,
    .research-metric-card__value span {
      font-size: 0.8125rem;
    }

    .research-metric-card__value strong {
      font-size: 1.125rem;
    }
  }
</style>
