<script lang="ts">
 import PanelHeading from '../trading-research/PanelHeading.svelte';
 import ModuleCard from '../../components/ModuleCard.svelte';
 import { goto } from '$app/navigation';
 import { Button } from '$lib/components/ui/button/index.js';
 import { Input } from '$lib/components/ui/input/index.js';
 import { NativeSelect } from '$lib/components/ui/native-select/index.js';
 import { Checkbox } from '$lib/components/ui/checkbox/index.js';
 import { globalMessages } from '$lib/global-messages';
 import { hasPermission } from '$lib/permissions';
 import { debtEditorFields, debtEditorPayload, valueForEditor, type EntityConfig, type DataRow } from './data-admin';
 import { NeonDataApi } from './neon-data-api';
 let { config, entry, returnHref, permissions }: {config: EntityConfig; entry: string; returnHref: string; permissions: string[]} = $props();
 const api = new NeonDataApi();
 const creating = $derived(entry === 'new');
 const writable = $derived(hasPermission(permissions, creating ? 'financing.data:create' : 'financing.data:update'));
 const fields = $derived(debtEditorFields(config, creating ? 'create' : 'edit'));
 let values = $state<DataRow>({});
 let original = $state<DataRow | null>(null);
 let loading = $state(true);
 let saving = $state(false);
 let deleting = $state(false);
 let error = $state('');
 let request = 0;
 $effect(() => {
  const entity = config, id = entry, current = ++request;
  loading = true; error = ''; original = null;
  void (async () => {
   try {
    const row = id === 'new' ? null : await api.get(entity, id);
    if (current !== request) return;
    original = row;
    values = Object.fromEntries(debtEditorFields(entity, id === 'new' ? 'create' : 'edit').map(field => [field.key, row ? valueForEditor(field, row[field.key]) : field.type === 'boolean' ? false : field.options?.[0]?.value ?? '']));
   } catch (cause) { if(current === request) error = cause instanceof Error ? cause.message : String(cause); }
   finally { if(current === request) loading = false; }
  })();
  return () => { request++; };
 });
 async function save() {
  if (!writable || saving) return;
  saving = true; error = '';
  try {
   const payload = debtEditorPayload(config, creating ? 'create' : 'edit', values);
   if (creating) { const saved = await api.insert(config, payload); if (!saved[0]) throw new Error('新增失败，请重试'); }
   else if (original) await api.update(config, original, payload);
   globalMessages.success('已保存', { key: 'data-admin-mutation' });
   await goto(returnHref);
  } catch(cause) { globalMessages.error(cause instanceof Error ? cause.message : String(cause), {key:'data-admin-mutation'}); }
  finally { saving = false; }
 }
 async function remove() {
  if (saving || !original || !hasPermission(permissions, 'financing.data:delete') || !confirm(`确定删除“${original.name ?? config.label}”？`)) return;
  saving = true; deleting = true;
  try { await api.delete(config, original); globalMessages.success('已删除', {key:'data-admin-mutation'}); await goto(returnHref); }
  catch(cause) { globalMessages.error(cause instanceof Error ? cause.message : String(cause), {key:'data-admin-mutation'}); }
  finally { saving = false; deleting = false; }
 }
</script>
<ModuleCard class="debt-editor" labelledBy="debt-editor-title">
 <PanelHeading id="debt-editor-title" title={`${creating ? '新增' : '编辑'}${config.label}`} controlsInline><Button href={returnHref} variant="outline">返回列表</Button></PanelHeading>
 {#if error}<p role="alert" class="error">{error}</p>{/if}
 {#if loading}<p role="status">正在读取…</p>{:else if creating || original}
 <form onsubmit={event => { event.preventDefault(); void save(); }}>
  <fieldset disabled={!writable || saving}>
   <div class="field-grid">
    {#each fields as field (field.key)}
     <label><span>{field.label}{field.required ? ' *' : ''}</span>
      {#if field.type === 'select'}<NativeSelect aria-label={field.label} bind:value={values[field.key]} required={field.required}>{#if !field.required}<option value="">未设置</option>{/if}{#each field.options ?? [] as choice}<option value={choice.value}>{choice.label}</option>{/each}</NativeSelect>
      {:else if field.type === 'boolean'}<Checkbox aria-label={field.label} checked={Boolean(values[field.key])} onCheckedChange={checked => values[field.key] = checked}/>
      {:else}<Input aria-label={field.label} type={field.type === 'number' || field.type === 'date' ? field.type : 'text'} value={String(values[field.key] ?? '')} oninput={event => values[field.key] = event.currentTarget.value} required={field.required} min={field.min} max={field.max} step={field.step}/>{/if}
     </label>
    {/each}
   </div>
  </fieldset>
  <div class="editor-actions">{#if !creating && hasPermission(permissions, 'financing.data:delete')}<Button variant="destructive" type="button" onclick={() => void remove()} disabled={saving}>{deleting ? '删除中…' : '删除条目'}</Button>{/if}<Button href={returnHref} variant="outline" disabled={saving}>取消</Button>{#if writable}<Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>{/if}</div>
 </form>
 {/if}
</ModuleCard>
<style>
 :global(.debt-editor) {padding:1.5rem;}
 .editor-actions {display:flex;align-items:center;justify-content:space-between;gap:1rem;}
 fieldset {border:0;padding:0;margin:1.5rem 0;min-width:0;}
 .field-grid {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.25rem;}
 label {display:flex;flex-direction:column;gap:.5rem;min-width:0;font-size:.875rem;}
 .editor-actions {justify-content:flex-end;border-top:1px solid var(--line);padding-top:1.25rem;}
 .error {color:var(--destructive,#b42318);}
 @media(max-width:64rem){.field-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
 @media(max-width:40rem){:global(.debt-editor){padding:1rem;}.field-grid{grid-template-columns:1fr;}.editor-actions{flex-wrap:wrap;}}
</style>
