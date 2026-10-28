<script lang="ts">
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
	import MultiSelectFilter from './MultiSelectFilter.svelte';

	type Preset = { key: string; label: string; exclude: string[] };

	let {
		options,
		presets,
		preset = $bindable('all'),
		values = $bindable([]),
		ariaLabel = '筛选视图',
		note = '',
		compact = false
	}: {
		options: string[];
		presets: Preset[];
		preset: string;
		values: string[];
		ariaLabel?: string;
		note?: string;
		compact?: boolean;
	} = $props();

	const optionLabels = {
		'浮动收益凭证': '浮收',
		'固定收益凭证': '固收'
	};
	let expectedSignature = $state<string | null>(null);
	const signature = (items: string[]) => [...items].sort().join('|');

	function applyPreset(key: string) {
		preset = key;
		const selected = presets.find((item) => item.key === key);
		values = !selected || selected.exclude.length === 0
			? []
			: options.filter((option) => !selected.exclude.includes(option));
		expectedSignature = signature(values);
	}

	$effect(() => {
		const current = signature(values);
		if (expectedSignature === null) expectedSignature = current;
		if (preset !== 'custom' && current !== expectedSignature) preset = 'custom';
	});
</script>

<section class="ui-card border bg-card debt-filter" class:compact={compact} aria-label={ariaLabel}>
	<label>
		{#if !compact}<span>预设</span>{/if}
		<NativeSelect data-ui-owner="lib-financing-DebtPresetFilter-svelte" class={"ui-select"} aria-label="预设筛选" value={preset} onchange={(event) => applyPreset(event.currentTarget.value)}>
			{#each presets as item}
				<option value={item.key}>{item.label}</option>
			{/each}
			<option value="custom">自定义</option>
		</NativeSelect>
	</label>
	<MultiSelectFilter
		label="负债品种"
		options={options}
		bind:values
		allLabel="全部品种"
		{optionLabels}
	/>
	{#if note && !compact}<span class="filter-note">{note}</span>{/if}
</section>

<style>
	.debt-filter {
		display: flex;
		flex-direction: row;
		min-height: 4rem;
		align-items: center;
		gap: 1rem;
		padding: 0.6875rem 1rem;
	}

	label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	label span {
		font-size: 0.875rem;
		font-weight: bold;
		letter-spacing: 0.02em;
		color: var(--text-muted);
	}

	:global(select[data-ui-owner="lib-financing-DebtPresetFilter-svelte"]) {
		width: 13.5rem;
		min-width: 0;
		padding: 0 2rem 0 0.75rem;
	}

	.filter-note { margin-left: auto; color: var(--text-muted); font-size: .8125rem; white-space: nowrap; }

	.debt-filter.compact {
		min-height: 0;
		padding: 0;
	}

	:global(.debt-filter.compact select[data-ui-owner="lib-financing-DebtPresetFilter-svelte"]) {
		width: 12rem;
	}

	@media (min-width: 901px) {
		.debt-filter { border-radius: var(--radius-card); }
		.debt-filter.compact { border: 0; border-radius: 0; background: transparent; }
		label { flex: 0 0 auto; }
		:global(select[data-ui-owner="lib-financing-DebtPresetFilter-svelte"]),
		:global(.debt-filter.compact select[data-ui-owner="lib-financing-DebtPresetFilter-svelte"]) {
			width: auto;
			min-width: 12rem;
		}
	}

	@media (max-width: 64rem) {
		.debt-filter {
			align-items: stretch;
			flex-wrap: wrap;
		min-height: 4rem;
		}
	}

	@media (max-width: 35rem) {
		.debt-filter,
		label {
			align-items: stretch;
			flex-direction: column;
		}

		:global(select[data-ui-owner="lib-financing-DebtPresetFilter-svelte"]) {
			width: 100%;
		}
	}
</style>
