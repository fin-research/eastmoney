<script lang="ts">
  import MessengerView from './MessengerView.svelte';
  import TestMessageView from './TestMessageView.svelte';
  import type {DeliveryList,DeliveryDetail,TestRecipient} from './types';
  let {activeTab = 'delivery',list,detail=null,filters={},canRetry=false,canSend=false,people=[],requestId,message}:{activeTab?: 'delivery' | 'test';list:DeliveryList;detail?:DeliveryDetail|null;filters?:Record<string,string>;canRetry?:boolean;canSend?:boolean;people?:TestRecipient[];requestId:string;message?:string}=$props();
</script>
{#if activeTab === 'test' && canSend}
  <TestMessageView {people} {requestId} {canSend}/>
{:else}
  <MessengerView {list} {detail} {filters} {canRetry} {message}/>
{/if}
