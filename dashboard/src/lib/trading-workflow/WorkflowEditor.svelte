<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { workflowGroups } from './graph';
  import { nodeIcon, workflowIcons } from './icons';
  import { onMount } from 'svelte';
  import { descendants, isInquiry, nodeFlowIds, flowLabel, insertNode, reparentNode, moveNode, nodesSchema, type Product, type WorkflowConfig, type WorkflowNode } from './model';
  import { globalMessages } from '../global-messages';
  let { flows, nodes = $bindable(), selectedId, disabled, onSelect, onClose, onBranch, expanded, onSave, onDelete, onAdd, onReset }: {
    flows: WorkflowConfig['flows']; nodes: WorkflowNode[]; selectedId: string; disabled: boolean; onSelect: (id: string) => void;
    onDelete: (id: string) => void; onSave: () => void; onAdd: () => void; onReset: () => void;
    onClose: () => void; onBranch: (id: string, value: boolean) => void; expanded: boolean;
  } = $props();
  const selected = $derived(nodes.find(node => node.id === selectedId));
  const group = $derived(workflowGroups(nodes).find(items => items.some(node => node.id === selectedId)) ?? []);
  const offset = $derived(group[0]?.offset ?? { x: 0, y: 0 });
  function setOffset(axis: 'x' | 'y', value: number) {
    const ids = new Set(group.map(node => node.id));
    const next = { ...offset, [axis]: value };
    nodes = nodes.map(node => ids.has(node.id) ? { ...node, offset: next } : node);
  }
  const previous = $derived(nodes.filter(node => node.nextIds.includes(selectedId)));
  function apply(next: WorkflowNode[]) {
    const parsed = nodesSchema.safeParse(next);
    if (!parsed.success) { nodes = nodes.map(node => ({ ...node })); globalMessages.error(parsed.error.issues[0]?.message ?? '节点配置无效'); return; }
    nodes = parsed.data;
  }
  function setNext(index: number, id: string) {
    if (!selected) return;
    const nextIds = [...selected.nextIds];
    if (id) nextIds[index] = id; else nextIds.splice(index, 1);
    apply(nodes.map(node => node.id === selectedId ? { ...node, nextIds } : node));
  }
  function setFlow(id: Product, checked: boolean) {
    if (!selected) return;
    const flowIds = checked ? [...new Set([...selected.flowIds, id])] : selected.flowIds.filter(flow => flow !== id);
    const ids = descendants(nodes, selected.id);
    apply(nodes.map(node => ids.has(node.id) ? { ...node, flowIds } : node));
  }
  function setParent(parentId: string | null) {
    if (!selected || selected.parentId === parentId) return;
    apply(reparentNode(nodes, selected.id, parentId));
  }
  let panel: HTMLElement;
  onMount(() => panel.querySelector<HTMLInputElement>('input')?.focus());
  function remove(node: WorkflowNode) {
    if (!window.confirm(`删除“${node.title}”？子节点将自动接上。`)) return;
    onDelete(node.id);
  }
  function addChild(node: WorkflowNode) {
    const child: WorkflowNode = { id: crypto.randomUUID(), flowIds: [...node.flowIds], nextIds: [], kind: 'task', parentId: node.kind === 'branch' ? node.id : node.parentId, title: '新节点', detail: '', startTime: null, endTime: null };
    apply(insertNode(nodes, node, child));
    if (node.kind === 'branch') onBranch(node.id, true);
    onSelect(child.id);
  }
</script>

<aside class="workflow-editor" aria-labelledby="workflow-editor-title" bind:this={panel}>
  <div class="editor-heading"><h2 id="workflow-editor-title">节点编辑</h2><Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" variant="ghost" class={"ui-button "} type="button" aria-label="关闭节点编辑" onclick={onClose}>×</Button></div>
  <fieldset disabled={disabled} class="editor-fields">
    {#if selected}
      <label>编辑节点<NativeSelect data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-select"} value={selectedId} onchange={event => onSelect(event.currentTarget.value)}>
        {#each nodes as node}<option value={node.id}>{flowLabel(node, nodes, flows)} · {isInquiry(node) ? '询价' : node.title}</option>{/each}
      </NativeSelect></label>
      <label>节点名称<Input data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-input"} required maxlength={160} bind:value={selected.title} /></label>
      <fieldset class="connection-fields"><legend>所属流程</legend>
        {#each flows as flow}<label class="editor-checkbox"><Checkbox checked={nodeFlowIds(selected, nodes).includes(flow.id)} disabled={!selected.flowIds.includes(flow.id) && nodeFlowIds(selected, nodes).includes(flow.id)} onCheckedChange={checked => setFlow(flow.id, checked)} />{flow.label}</label>{/each}
      </fieldset>
      <fieldset class="connection-fields"><legend>前序节点</legend>
        {#each previous as node}<Button variant="ghost" class="connection-link" type="button" onclick={() => onSelect(node.id)}>{flowLabel(node, nodes, flows)} · {node.title}</Button>{:else}<span>起点</span>{/each}
      </fieldset>
      <fieldset class="connection-fields"><legend>后续节点</legend>
        {#each selected.nextIds as id, index}
          <div class="connection-row"><NativeSelect aria-label={`后续节点 ${index + 1}`} value={id} onchange={event => { const value = event.currentTarget.value; event.currentTarget.value = id; setNext(index, value); }}>
            {#each nodes.filter(node => node.id !== selectedId) as target}<option value={target.id}>{flowLabel(target, nodes, flows)} · {target.title}</option>{/each}
          </NativeSelect><Button variant="ghost" type="button" aria-label={`移除后续节点 ${index + 1}`} onclick={() => setNext(index, '')}>×</Button></div>
        {/each}
        <NativeSelect aria-label="添加后续节点" value="" onchange={event => { const id = event.currentTarget.value; event.currentTarget.value = ''; if (selected && id) setNext(selected.nextIds.length, id); }}>
          <option value="">添加后续节点</option>
          {#each nodes.filter(node => node.id !== selectedId && !selected.nextIds.includes(node.id)) as target}<option value={target.id}>{flowLabel(target, nodes, flows)} · {target.title}</option>{/each}
        </NativeSelect>
        <div class="editor-pair"><Button variant="outline" type="button" disabled={moveNode(nodes, selectedId, -1) === nodes} onclick={() => apply(moveNode(nodes, selectedId, -1))}>上移</Button><Button variant="outline" type="button" disabled={moveNode(nodes, selectedId, 1) === nodes} onclick={() => apply(moveNode(nodes, selectedId, 1))}>下移</Button></div>
      </fieldset>
      <label>备注<Textarea data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-textarea"} maxlength={1200} rows={4} bind:value={selected.detail}></Textarea></label>
      <Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" variant="default" class={"ui-button  editor-save"} type="button" onclick={onSave}>{disabled ? '保存中…' : '保存'}</Button>
      <div class="editor-actions"><Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" variant="destructive" type="button" class={"ui-button  "} onclick={() => selected && remove(selected)}>删除节点</Button><Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" variant="outline" type="button" class={"ui-button  "} onclick={() => selected && addChild(selected)}>新增下级节点</Button></div>
      <details class="editor-advanced"><summary>节点设置</summary><div class="editor-settings">
      <fieldset class="icon-options"><legend>节点图标</legend>
        {#each Object.entries(workflowIcons) as [value, item]}
          <button type="button" aria-label={item.label} aria-pressed={nodeIcon(selected) === value} onclick={() => { if (selected) selected.icon = value as NonNullable<WorkflowNode['icon']>; }}><item.component size={20} aria-hidden="true" /></button>
        {/each}
      </fieldset>
      {#if selected.kind === 'task'}
        <div class="editor-pair">
          <label>开始 / 提醒<Input data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-input"} type="time" value={selected.startTime ?? ''} oninput={event => { if (selected) selected.startTime = event.currentTarget.value || null; }} /></label>
          <label>结束<Input data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-input"} type="time" value={selected.endTime ?? ''} oninput={event => { if (selected) selected.endTime = event.currentTarget.value || null; }} /></label>
        </div>
      {/if}

        <label>节点类型<NativeSelect data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-select"} value={selected.kind} onchange={event => {
          if (!selected) return;
          if (event.currentTarget.value === 'task' && nodes.some(node => node.parentId === selectedId)) return;
          selected.kind = event.currentTarget.value as 'task' | 'branch';
          if (selected.kind === 'branch') { selected.startTime = null; selected.endTime = null; }
        }}><option value="task" disabled={nodes.some(node => node.parentId === selectedId)}>任务</option><option value="branch">条件分支</option></NativeSelect></label>
        <label>上级分支<NativeSelect data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-select"} value={selected.parentId ?? ''} onchange={event => setParent(event.currentTarget.value || null)}>
          <option value="">主流程</option>
          {#each nodes.filter(node => node.flowIds.some(id => selected.flowIds.includes(id)) && node.kind === 'branch' && !descendants(nodes, selected.id).has(node.id)) as parent}<option value={parent.id}>{parent.title}</option>{/each}
        </NativeSelect></label>
        {#if selected.kind === 'task'}
          <label class="editor-checkbox"><Checkbox data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte"  checked={isInquiry(selected)} onCheckedChange={checked => { if (selected) selected.inquiry = checked; }} />询价输入框</label>
        {:else}<label class="editor-checkbox"><Checkbox data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte"  checked={expanded} onCheckedChange={checked => onBranch(selectedId, checked)} />展开分支</label>{/if}
        <div class="editor-pair">
          <label>水平偏移<Input data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-input"} type="number" min="-10000" max="10000" value={offset.x} oninput={event => setOffset('x', event.currentTarget.valueAsNumber || 0)} /></label>
          <label>垂直偏移<Input data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" class={"ui-input"} type="number" min="-10000" max="10000" value={offset.y} oninput={event => setOffset('y', event.currentTarget.valueAsNumber || 0)} /></label>
        </div>
        <Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" variant="ghost" class={"ui-button "} type="button" onclick={onReset}>恢复自动布局</Button>
      </div></details>
    {:else}<Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" type="button" onclick={onSave}>保存</Button><Button data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte" variant="default" class={"ui-button "} type="button" onclick={onAdd}>新增节点</Button>{/if}
  </fieldset>
</aside>

<style>
  .workflow-editor { width: 350px; max-height: calc(100dvh - 120px); overflow-y: auto; padding: 24px; background: #fff; border-radius: 8px; flex: none; position: sticky; top: 0; }
  .editor-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #dde6f4; }
  h2 { font-size: 1.25rem; font-weight: bold; margin: 0; }
  .editor-fields { border: 0; margin: 0; padding: 0; display: grid; gap: 22px; min-width: 0; }
  .editor-fields label { display: grid; gap: 8px; font-weight: bold; font-size: 1rem; min-width: 0; }
  :global(.editor-fields :is(input[data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte"]:not([type="checkbox"]), select[data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte"], textarea[data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte"])) { width: 100%; font-weight: normal; }
  .editor-fields .editor-checkbox { display: flex; align-items: center; gap: 10px; }
  .connection-fields { border: 0; padding: 0; margin: 0; display: grid; gap: 10px; min-width: 0; }
  .connection-fields legend { font-weight: bold; margin-bottom: 8px; }
  .connection-fields :global(.connection-link) { height: auto; justify-content: flex-start; padding-inline: 0; white-space: normal; overflow-wrap: anywhere; text-align: left; }
  .connection-row { display: flex; gap: 8px; min-width: 0; }
  .connection-row :global(select) { min-width: 0; flex: 1; }
  .editor-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  :global(.editor-save[data-ui-owner="lib-trading-workflow-WorkflowEditor-svelte"]) { width: 100%; }
  .editor-advanced { border: 1px solid var(--tr-border); border-radius: 8px; }
  .editor-advanced > summary { min-height: 44px; padding: 10px 12px; cursor: pointer; font-weight: bold; }
  .editor-advanced[open] > summary { border-bottom: 1px solid var(--tr-border); }
  .editor-settings { display: grid; gap: 16px; padding: 12px; }
  .icon-options { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; border: 0; padding: 0; margin: 0; }
  .icon-options legend { font-weight: bold; margin-bottom: 8px; }
  .icon-options button { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--tr-border); border-radius: 8px; background: var(--background); color: var(--tr-muted); cursor: pointer; }
  .icon-options button[aria-pressed="true"] { color: var(--brand); border-color: var(--brand); background: var(--accent); }
  .icon-options button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .editor-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (min-width: 1024px) { .workflow-editor { padding-bottom: 88px; } }
  @media (max-width: 1200px) { .workflow-editor { position: fixed; right: 16px; bottom: 16px; z-index: 30; width: min(340px, calc(100vw - 32px)); max-height: calc(100dvh - 130px); border: 1px solid var(--tr-border); box-shadow: 0 8px 32px rgb(23 32 51 / 12%); } }
</style>
