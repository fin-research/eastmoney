<script lang="ts">
  import { page } from '$app/state';
  import { notificationTab } from '$lib/workbench/navigation';
  import NotificationManagement from '$lib/messenger/NotificationManagement.svelte';
  let {data,form}=$props();
</script>
<NotificationManagement activeTab={notificationTab(page.url.searchParams.get('tab'))} {...data} message={form?.message} />
