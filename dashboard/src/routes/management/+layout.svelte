<script lang="ts">
import { page } from '$app/state';
import WorkbenchShell from '$lib/workbench/WorkbenchShell.svelte';
import { managementViews, managementPeopleTabs, managementPeopleTab, notificationTabs, notificationTab } from '$lib/workbench/navigation';
let { children } = $props();
const activeViewId = $derived(page.url.pathname.split('/')[2] ?? 'me');
</script>
<WorkbenchShell title="管理" homeHref="/management" views={managementViews} {activeViewId}
  tabs={activeViewId === 'messenger' ? notificationTabs : activeViewId === 'people' ? managementPeopleTabs : []}
  activeTabId={activeViewId === 'people' ? managementPeopleTab(page.url.searchParams.get('tab')) : notificationTab(page.url.searchParams.get('tab'))}
  class="management-scope" tone="purple">{@render children()}</WorkbenchShell>
