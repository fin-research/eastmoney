<script lang="ts">
  import { onDestroy } from 'svelte';
  import ModuleCard from '../../components/ModuleCard.svelte';
  import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { globalMessages } from '$lib/global-messages';
  import { incrementForIndex, type ImportWorkbook } from './debt-import-json';
  import { withBase } from './app-paths';
  let file = $state<File | null>(null);
  let busy = $state(false);
  let phase = $state('导入');
  let input = $state<HTMLInputElement | null>(null);
  let worker: Worker | null = null;
  onDestroy(()=>worker?.terminate());
  async function post(body: unknown) {
    const response=await fetch(withBase('/data/import'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error??'导入失败');
    return result;
  }
  async function upload() {
    if(!file||busy)return;
    busy=true;phase='解析中';
    try {
      if(!file.name.toLowerCase().endsWith('.xlsx')||file.size>10*1024*1024)throw new Error('请选择不超过 10 MB 的 .xlsx 文件');
      const data=await file.arrayBuffer();
      const {parsed,warnings}=await new Promise<{parsed:ImportWorkbook;warnings:string[]}>((resolve,reject)=>{
        worker=new Worker(new URL('./debt-import.worker.js',import.meta.url),{type:'module'});
        worker.onmessage=({data})=>{worker?.terminate();worker=null;data.type==='complete'?resolve({parsed:data.transformed,warnings:data.warnings??[]}):reject(new Error(data.message));};
        worker.onerror=(event)=>{worker?.terminate();worker=null;reject(new Error(event.message||'工作簿解析失败'));};
        worker.postMessage({workbookData:data,fileName:file!.name},[data]);
      });
      phase='核对中';
      const index=await post({action:'index'});
      const increment=incrementForIndex(parsed,index);
      phase='提交中';
      const result=await post(increment);
      globalMessages.success(`新增 ${result.insertedDebtCount} 笔负债、${result.insertedCashflowCount} 笔现金流${result.createdClientCount?`、${result.createdClientCount} 个客户`:''}；保留 ${parsed.debts.length-result.insertedDebtCount} 笔历史负债`,{title:'导入完成',duration:0});
      for(const warning of warnings)globalMessages.warning(warning,{title:'导入提示',duration:0});
      for(const warning of result.warnings??[])globalMessages.warning(warning,{title:'导入提示',duration:0});
      file=null;if(input)input.value='';
    } catch(error) {
      globalMessages.error(error instanceof Error?error.message:String(error),{title:'导入失败',duration:0});
    } finally {busy=false;phase='导入';}
  }
</script>
<ModuleCard labelledBy="debt-import-title">
  <PanelHeading id="debt-import-title" title="借入资金汇总表" />
  {#if file}<p class="selected-file">{file.name} · {(file.size/1024/1024).toFixed(2)} MB</p>{/if}
  <div class="import-controls">
    <Input bind:ref={input} type="file" aria-label="选择借入资金汇总表" accept=".xlsx" disabled={busy} onchange={(event)=>file=(event.currentTarget as HTMLInputElement).files?.[0]??null} />
    <Button disabled={!file||busy} onclick={upload}>{phase}</Button>
  </div>
</ModuleCard>
<style>.import-controls{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}.import-controls :global(input){flex:1;min-width:12rem}</style>
