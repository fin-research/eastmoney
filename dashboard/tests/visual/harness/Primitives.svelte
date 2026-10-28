<script lang="ts">
  import MultiSelectFilter from '../../../src/lib/financing/MultiSelectFilter.svelte';
  import Modal from '../../../src/lib/components/Modal.svelte';
  import { Button } from '../../../src/lib/components/ui/button/index.js';
  import { Input } from '../../../src/lib/components/ui/input/index.js';
  let values = $state<string[]>([]);
  let dialog: Modal;
  let busy = $state(false);
  let closeCount = $state(0);
</script>
<main class="p-6 space-y-6">
  <h1>组件交互</h1>
  <MultiSelectFilter label="负债品种" options={['固定收益凭证','公司债']} bind:values allLabel="全部品种" optionLabels={{'固定收益凭证':'固收'}} />
  <Button onclick={() => dialog.showModal()}>打开表单</Button>
  <div class="page-shell">
  <Button href="/ui-contracts" disabled>禁用链接</Button>
  <Button disabled>禁用按钮</Button>
  <Button aria-disabled="true">ARIA 禁用按钮</Button>
  <Button data-disabled>数据禁用按钮</Button>
  <button type="button">原生按钮</button>
  </div>
  <p role="status">关闭次数：{closeCount}</p>
  <Modal onclose={() => closeCount++} bind:this={dialog} aria-labelledby="fixture-title" oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="fixture-title">编辑表单</h2>
    <label>项目名称<Input name="name" required /></label>
    <Button onclick={() => busy = !busy}>{busy ? '恢复编辑' : '模拟保存中'}</Button>
    <Button onclick={() => dialog.close()} disabled={busy}>关闭表单</Button>
  </Modal>
</main>
