<script lang="ts">
  import { withBase } from '../financing/app-paths.ts';
  import { scrollableRegion } from '../scrollable-region';
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { NativeSelect } from '$lib/components/ui/native-select/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { creditEffectiveStatus } from '../credit/validity.ts';
  import { permissionVisibility } from '../permission-visibility.ts';
  import { globalMessages } from '../global-messages.ts';
  import { fetchCreditUsage, updateCreditInstitution } from '../credit/client.ts';
  import { creditMaintenanceAmounts, creditMaintenanceChanges, creditMaintenanceDraft, setCreditBondUsage, type CreditMaintenanceDraft } from '../credit/maintenance.ts';
  import { creditItemLabels, type CreditUsageType, type CreditUsageDetail, type CreditInstitutionView, type CreditInstitutionUpdateResponse, type CreditItemType } from '../credit/types.ts';

  let { institution, reportDate, calendarMonth, firstDate, previousDate, contextVersion, onapplied }: {
    institution: CreditInstitutionView;
    reportDate: string; calendarMonth: string; firstDate?: string; previousDate: string | null; contextVersion: number;
    onapplied: (result: CreditInstitutionUpdateResponse, contextVersion: number) => void;
  } = $props();
  const allowed = permissionVisibility();
  const canEdit = $derived($allowed('credit.institution:update'));
  const itemOrder: CreditItemType[] = ['bond_investment', 'yield_certificate', 'interbank_lending', 'legal_overdraft', 'other'];
  let draft = $state<CreditMaintenanceDraft>(null!);
  $effect.pre(() => {
    draft = creditMaintenanceDraft(institution);
  });
  let saving = $state(false);
  let usageType = $state<CreditUsageType | null>(null);
  let usage = $state<CreditUsageDetail | null>(null);
  let usageLoading = $state(false);
  let usageError = $state('');
  let usageSequence = 0;
  let usageBack = $state<HTMLButtonElement | null>(null);
  let usageTrigger: HTMLElement | null = null;
  $effect(() => {
    institution.institutionName; reportDate; contextVersion;
    usageSequence++; usageType = null; usage = null; usageLoading = false; usageError = '';
  });
  async function openUsage(type: CreditUsageType, offset = 0, event?: MouseEvent): Promise<void> {
    if (event) usageTrigger = event.currentTarget as HTMLElement;
    const sequence = ++usageSequence;
    const name = institution.institutionName, date = reportDate;
    usageType = type; usageLoading = true; usageError = ''; usage = null;
    await tick();
    usageBack?.focus();
    try {
      const result = await fetchCreditUsage(date,name,type,offset);
      if (sequence === usageSequence && name === institution.institutionName && date === reportDate) usage = result;
    } catch (error) {
      if (sequence === usageSequence) usageError = error instanceof Error ? error.message : '融资条目加载失败';
    } finally { if (sequence === usageSequence) usageLoading = false; }
  }
  async function returnToEditor() {
    usageSequence++; usageType = null; usageLoading = false; usageError = '';
    await tick();
    usageTrigger?.focus();
  }
  const amounts = $derived(creditMaintenanceAmounts(institution, draft));

  function numberInput(event: Event): number | null {
    const value = (event.currentTarget as HTMLInputElement).value;
    return value === '' ? null : Number(value);
  }
  function formatAmount(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(2);
  }
  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canEdit || saving) return;
    if (draft.effectiveDate && draft.expiryDate && draft.expiryDate !== '1970-01-01' && draft.effectiveDate > draft.expiryDate) {
      globalMessages.error('授信到期日不能早于生效日');
      return;
    }
    const changes = creditMaintenanceChanges(institution, draft);
    if (!changes.institution && !changes.items) {
      globalMessages.info('没有需要保存的变更');
      return;
    }
    saving = true;
    const version = contextVersion;
    try {
      const result = await updateCreditInstitution({ operation: 'maintenance', reportDate, viewDate:reportDate, viewFirstDate:firstDate, viewPreviousDate:previousDate, calendarMonth,
        institutionName: institution.institutionName, changes }, fetch);
      onapplied(result,version);
      globalMessages.success('授信维护已保存');
    } catch (error) {
      globalMessages.error(error instanceof Error ? error.message : '授信维护保存失败');
    } finally {
      saving = false;
    }
  }
</script>

{#if usageType}
  <section class="tr-credit-usage" aria-label="融资条目" aria-busy={usageLoading}>
    <div class="tr-credit-usage-head"><Button bind:ref={usageBack} variant="outline" type="button" onclick={returnToEditor}>返回授信详情</Button><h3>{usageType === 'bond_investment' ? '一级发行' : creditItemLabels[usageType]}</h3><span>{reportDate}</span></div>
    {#if usageLoading}<p role="status">加载中…</p>
    {:else if usageError}<p role="alert">{usageError}</p><Button variant="outline" type="button" onclick={() => openUsage(usageType!)}>重试</Button>
    {:else if usage}
      <div class="tr-credit-usage-summary"><strong>{institution.institutionName}</strong><span>{usage.totalCount} 笔 · {formatAmount(usage.totalUsed)} 亿元</span></div>
      {#if !usage.linked}<p>客户关联缺失</p>
      {:else if !usage.totalCount}<p>暂无存续融资条目</p>
      {:else}
        <div class="tr-table-scroll" role="region" aria-label="融资条目列表" use:scrollableRegion>
          <table class="tr-data-table"><thead><tr><th>融资条目</th><th>关联客户</th><th class="is-numeric">已用（亿元）</th><th>生效日</th><th>到期日</th></tr></thead><tbody>
            {#each usage.items as entry (`${entry.id}:${entry.clientName}`)}<tr><td>{#if $allowed('financing.data:read')}<a href={withBase(`/debts/${entry.id}`)}>{entry.name || '—'}</a>{:else}{entry.name || '—'}{/if}</td><td>{entry.clientName}</td><td class="is-numeric">{formatAmount(entry.amount)}</td><td>{entry.startDate ?? '—'}</td><td>{entry.maturityDate ?? '—'}</td></tr>{/each}
          </tbody></table>
        </div>
        {#if usage.totalCount > 100}<div class="tr-credit-usage-pagination"><Button variant="outline" disabled={!usage.offset} onclick={() => openUsage(usageType!,Math.max(0,usage!.offset-100))}>上一页</Button><span>{Math.floor(usage.offset/100)+1} / {Math.ceil(usage.totalCount/100)}</span><Button variant="outline" disabled={usage.offset+100 >= usage.totalCount} onclick={() => openUsage(usageType!,usage!.offset+100)}>下一页</Button></div>{/if}
      {/if}
    {/if}
  </section>
{/if}
<form class="tr-credit-detail" hidden={usageType !== null} onsubmit={save}>
  <div class="tr-credit-editor-head">
    <strong>{institution.institutionName}</strong>
    <label class="tr-credit-final-toggle"><span>定稿</span><Switch aria-label="定稿" bind:checked={draft.verified} disabled={!canEdit || saving} /></label>
    <Button permission="credit.institution:update" type="submit" disabled={saving}>{saving ? '保存中' : '保存'}</Button>
  </div>
  <div class="tr-credit-editor-grid">
    <label><span>机构性质</span><Input maxlength={100} bind:value={draft.institutionType} disabled={!canEdit || saving} /></label>
    <label><span>状态</span>
      {#if !draft.expiryDate}
        <NativeSelect bind:value={draft.status} disabled={!canEdit || saving}><option value="applying">申请中</option><option value="approved">已获批</option></NativeSelect>
      {:else}
        <Input value={creditEffectiveStatus({reportDate,expiryDate:draft.expiryDate,status:draft.status}) === 'approved' ? '已获批' : draft.expiryDate === '1970-01-01' ? '已撤销' : '申请中'} disabled />
      {/if}
    </label>
    <label><span>保密协议</span><NativeSelect value={draft.confidentialityStatus ? 'true' : 'false'} disabled={!canEdit || saving}
      onchange={event => draft.confidentialityStatus = (event.currentTarget as HTMLSelectElement).value === 'true'}>
      <option value="true">已签署</option><option value="false">未签署</option>
    </NativeSelect></label>
    <label><span>授信总额（亿元）</span><Input type="number" value={institution.totalLimit ?? ''} disabled /></label>
    <label><span>已用额度（亿元）</span><Input value={formatAmount(amounts.totalUsed)} disabled /></label>
    <label><span>可用额度（亿元）</span><Input value={formatAmount(amounts.available)} disabled /></label>
    <label><span>生效日</span><Input type="date" bind:value={draft.effectiveDate} disabled={!canEdit || saving} /></label>
    <label><span>到期日</span><Input type="date" bind:value={draft.expiryDate} disabled={!canEdit || saving} /></label>
    <label><span>关联客户</span><Input value={institution.clients?.map(client => client.name).join('、') || '—'} disabled /></label>
    <label><span>银行经办机构</span><Input maxlength={500} bind:value={draft.bankOffice} disabled={!canEdit || saving} /></label>
    <label><span>我司申请部门</span><Input maxlength={500} bind:value={draft.applyingDepartment} disabled={!canEdit || saving} /></label>
    <label><span>我司经办人</span><Input maxlength={200} bind:value={draft.handler} disabled={!canEdit || saving} /></label>
  </div>
  <div class="tr-credit-item-grid">
    {#each itemOrder as type}
      {@const item = institution.items.find(value => value.type === type)}
      <fieldset class:tr-credit-item-other={type === 'other'} class:tr-credit-item-bond={type === 'bond_investment'}>
        <legend>{creditItemLabels[type]}</legend>
        {#if type !== 'other'}
          <label><span>额度（亿元）</span><Input type="number" min="0" step="0.000001" value={draft.items[type].limitAmount ?? ''} disabled={!canEdit || saving} oninput={event => draft.items[type].limitAmount = numberInput(event)} /></label>
        {/if}
        {#if type === 'bond_investment'}
          <label><span>已用（亿元）</span><Input type="number" step="0.000001" value={amounts.used[type] ?? ''} disabled={!canEdit || saving || item?.primaryUsedAmount == null} oninput={event => setCreditBondUsage(institution, draft, 'used', numberInput(event))} /></label>
        {:else if type === 'legal_overdraft' || type === 'other'}
          <label><span>已用（亿元）</span><Input type="number" step="0.000001" value={draft.items[type].usedAmount ?? ''} disabled={!canEdit || saving} oninput={event => draft.items[type].usedAmount = numberInput(event)} /></label>
        {:else}
          <div class="tr-credit-usage-field"><span>已用（亿元）</span><Button variant="outline" type="button" class="tr-credit-usage-button" aria-label={`${creditItemLabels[type]}已用（亿元）`} disabled={amounts.used[type] == null} onclick={event => openUsage(type as CreditUsageType,0,event)}>{formatAmount(amounts.used[type])}<span aria-hidden="true">›</span></Button></div>
        {/if}
        {#if type === 'bond_investment'}
          <label><span>可用（亿元）</span><Input type="number" step="0.000001" value={amounts.remaining[type] ?? ''} disabled={!canEdit || saving || item?.primaryUsedAmount == null || draft.items[type].limitAmount == null} oninput={event => setCreditBondUsage(institution, draft, 'remaining', numberInput(event))} /></label>
          <div class="tr-credit-bond-components">
            <div class="tr-credit-usage-field"><span>一级发行</span><Button variant="outline" type="button" class="tr-credit-usage-button" aria-label="一级发行（亿元）" disabled={item?.primaryUsedAmount == null} onclick={event => openUsage('bond_investment',0,event)}>{formatAmount(item?.primaryUsedAmount)}<span aria-hidden="true">›</span></Button></div>
            <label><span>二级买卖</span><Input aria-label="二级买卖（亿元）" type="number" step="0.000001" value={draft.items[type].secondaryUsedAmount ?? ''} disabled={!canEdit || saving} oninput={event => draft.items[type].secondaryUsedAmount = numberInput(event)} /></label>
          </div>
        {:else if type !== 'other'}
          <label><span>可用（亿元）</span><Input value={formatAmount(amounts.remaining[type])} disabled /></label>
        {/if}
        {#if type === 'bond_investment' || type === 'other'}
          <label><span>说明</span><Textarea rows={1} maxlength={4000} bind:value={draft.items[type].details} disabled={!canEdit || saving} /></label>
        {/if}
      </fieldset>
    {/each}
  </div>
  <div class="tr-credit-notes-grid">
    <label><span>授信额度明细</span><Textarea rows={1} maxlength={4000} bind:value={draft.detail} disabled={!canEdit || saving} /></label>
    <label><span>债券投资偏好</span><Textarea rows={1} maxlength={4000} bind:value={draft.bondPreference} disabled={!canEdit || saving} /></label>
    <label><span>备注</span><Textarea rows={1} maxlength={8000} bind:value={draft.notes} disabled={!canEdit || saving} /></label>
  </div>
</form>

<style>
  .tr-credit-final-toggle { display: flex; align-items: center; gap: 0.5rem; min-height: 44px; margin-left: auto; }
</style>
