<script lang="ts">
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import ModuleCard from '../../../src/components/ModuleCard.svelte';
  import PanelHeading from '../../../src/lib/trading-research/PanelHeading.svelte';
  import DebtPresetFilter from '../../../src/lib/financing/DebtPresetFilter.svelte';
  import '../../../src/routes/financing/layout.css';
  const options=['同业拆借','互换便利','浮动收益凭证','固定收益凭证','小公募'];
  const presets=[{key:'all',label:'全量',exclude:[]},{key:'core_financing',label:'不含拆借、互换便利、浮动收益凭证',exclude:options.slice(0,3)}];
  const calendarPresets=[{key:'default',label:'不含拆借、浮动收益凭证',exclude:['同业拆借','浮动收益凭证']},{key:'all',label:'全部',exclude:[]}];
  let preset=$state('core_financing'),values=$state(options.slice(3));
  let calendarPreset=$state('default'),calendarValues=$state(['互换便利','固定收益凭证','小公募']);
</script>
<WorkbenchShell title="融资工作台" homeHref="/financing/" views={[{id:'filters',label:'仪表盘',href:'/financing/filters',icon:'overview'}]} activeViewId="filters" class="financing-scope">
  <DebtPresetFilter {options} {presets} bind:preset bind:values ariaLabel="总览筛选" />
  <ModuleCard>
    <PanelHeading id="calendar-filter-title" title="融资日历">
      <DebtPresetFilter {options} presets={calendarPresets} bind:preset={calendarPreset} bind:values={calendarValues} compact ariaLabel="日历筛选"/>
    </PanelHeading>
  </ModuleCard>
</WorkbenchShell>
