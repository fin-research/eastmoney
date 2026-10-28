<script lang="ts">
  import { managementViews, notificationTabs, notificationTab } from '../../../src/lib/workbench/navigation';
  const activeTab = notificationTab(new URL(window.location.href).searchParams.get('tab'));
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import NotificationManagement from '../../../src/lib/messenger/NotificationManagement.svelte';
  const failed={id:'fixture-message',source:'financing',channel:'email',status:'failed',subject:'融资项目节点提醒',recipient:'test@example.com',attempts:6,providerId:null,error:'EMAIL_RATE_LIMIT',createdAt:1789441200000,updatedAt:1789441200000,nextAttemptAt:1789441200000};
  const uncertain={...failed,id:'fixture-telegram',source:'ingest',channel:'telegram',status:'uncertain',subject:'中国央行：开展公开市场操作',recipient:'默认 Telegram',attempts:1};
  const workflow={...failed,id:'fixture-workflow',source:'notification',status:'accepted',subject:'【Workflow 失败】economic-indicator-sync '+JSON.stringify({error:{code:'UPSTREAM_FAILED',upstreamCode:10001003,url:'https://dash.cloudflare.com/'+ 'abcdef0123456789'.repeat(8)}}),recipient:'workflow-notifications-and-monitoring@example.com',attempts:1};
</script>
<WorkbenchShell title="管理" homeHref="/management" views={managementViews} activeViewId="messenger" activeLabel="通知管理" activeHref="/management/messenger" tabs={notificationTabs} activeTabId={activeTab} tone="purple">
<NotificationManagement {activeTab} list={{items:[failed,uncertain,workflow],counts:[{status:'failed',count:1},{status:'uncertain',count:1},{status:'accepted',count:1}],nextCursor:null}} canRetry={true} canSend={true} requestId="123e4567-e89b-42d3-a456-426614174000" people={[{id:"auth0|one",name:"测试甲",email:"one@example.com"},{id:"auth0|two",name:"测试乙",email:"two@example.com"}]} detail={{...failed,content:{html:'<p>节点提醒</p>'},history:[{number:6,started_at:1789441200000,finished_at:1789441201000,status:'failed',provider_id:null,error:'EMAIL_RATE_LIMIT'}],retries:[]}} />

</WorkbenchShell>
