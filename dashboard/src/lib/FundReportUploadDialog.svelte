<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { isLoginRedirecting } from "$lib/auth-client";

  import {
    fundReportDateFromFileName,
    fundReportFileName,
    MAX_FUND_REPORT_BYTES,
  } from "$lib/fund-report";
  import { globalMessages } from "$lib/global-messages";

  interface UploadResult {
    date: string;
    fileName: string;
    url: string;
    replaced: boolean;
  }

  let fileInput = $state<HTMLInputElement>(null!);
  let selectedFile = $state<File | null>(null);
  let selectedDate = $state("");
  let uploading = $state(false);
  interface Props {
    onuploaded?: (result: UploadResult) => void;
  }

  let { onuploaded = () => {} }: Props = $props();
  let dialog = $state<Modal>(null!);
  export function open(): void { dialog.showModal(); }

  function chooseFile(): void {
    fileInput.click();
  }

  function handleFileSelection(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    selectedFile = null;
    selectedDate = "";
    if (!file) return;

    const reportDate = fundReportDateFromFileName(file.name);
    if (!reportDate) {
      input.value = "";
      globalMessages.error(
        "文件名末尾必须包含有效日期，例如 资金日报驾驶舱交互版_20260824.html",
        { key: "fund-report-upload", title: "文件名无效", duration: 8000 },
      );
      return;
    }
    if (file.size <= 0 || file.size > MAX_FUND_REPORT_BYTES) {
      input.value = "";
      globalMessages.error("资金日报文件必须大于 0 且不超过 20 MB", {
        key: "fund-report-upload",
        title: "文件大小无效",
        duration: 8000,
      });
      return;
    }
    selectedFile = file;
    selectedDate = reportDate;
  }

  async function uploadFundReport(): Promise<void> {
    if (!selectedFile || !selectedDate || uploading) return;
    uploading = true;
    const operationMessage = globalMessages.info(
      `正在上传 ${selectedFile.name}`,
      {
        key: "fund-report-upload",
        title: "资金日报处理中",
        duration: 120_000,
      },
    );
    try {
      const response = await fetch("/api/fund-report", {
        method: "POST",
        headers: {
          "Content-Type": "text/html",
          "X-Fund-Report-Filename": encodeURIComponent(selectedFile.name),
          "X-Fund-Report-Size": String(selectedFile.size),
        },
        body: selectedFile,
      });
      const payload = (await response.json()) as UploadResult & {
        error?: string;
        detail?: string;
      };
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || "资金日报上传失败");
      }
      if (operationMessage) globalMessages.dismiss(operationMessage);
      selectedFile = null;
      selectedDate = "";
      fileInput.value = "";
      dialog.close();
      onuploaded(payload);
      globalMessages.success(
        `${payload.fileName} 已${payload.replaced ? "更新" : "上传"}`,
        { key: "fund-report-upload", title: "资金日报已保存", duration: 8000 },
      );
    } catch (error) {
      if (operationMessage) globalMessages.dismiss(operationMessage);
      if (isLoginRedirecting()) return;
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "fund-report-upload", title: "资金日报上传失败", duration: 8000 },
      );
    } finally {
      uploading = false;
    }
  }

  function formatSize(size: number): string {
    return size >= 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(2)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  }
</script>

<Modal  bind:this={dialog} aria-labelledby="fund-report-upload-title" oncancel={(event) => { if (uploading) event.preventDefault(); }}>
<div class="dialog-body upload-dialog-body">
  <header class="dialog-heading">
    <h2 id="fund-report-upload-title">上传资金日报</h2>
    <Button data-ui-owner="lib-FundReportUploadDialog-svelte" variant="ghost" class={"ui-button  close-button"} type="button" aria-label="关闭上传窗口" disabled={uploading} onclick={() => dialog.close()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></Button>
  </header>
      <form
        class="upload-form"
        aria-busy={uploading}
        onsubmit={(event) => {
          event.preventDefault();
          uploadFundReport();
        }}
      >
        <Input data-ui-owner="lib-FundReportUploadDialog-svelte"
          bind:ref={fileInput}
          class={"upload-file-input"}
          type="file"
          accept=".html,text/html"
          aria-label="选择资金日报 HTML 文件"
          disabled={uploading}
          onchange={handleFileSelection}
        />

        <Button data-ui-owner="lib-FundReportUploadDialog-svelte" variant="outline"

          class={["ui-button file-picker", selectedFile !== null && "selected"]}
          type="button"
          disabled={uploading}
          onclick={chooseFile}
        >
          <span class="file-picker-icon" aria-hidden="true">
            {#if selectedFile}
              <svg viewBox="0 0 24 24"><path d="M5 3h10l4 4v14H5zM15 3v5h5M8 13l2.5 2.5L16 10" /></svg>
            {:else}
              <svg viewBox="0 0 24 24"><path d="M4 6h6l2 2h8v11H4zM12 11v5m-2.5-2.5L12 11l2.5 2.5" /></svg>
            {/if}
          </span>
          <span class="file-picker-copy">
            <strong>{selectedFile ? selectedFile.name : "选择资金日报 HTML"}</strong>
          </span>
          <span class="file-picker-action">{selectedFile ? "重新选择" : "选择文件"}</span>
        </Button>

        {#if selectedFile}
          <section class="selected-file" aria-label="待上传文件" aria-live="polite">
            <dl>
              <div>
                <dt>报表日期</dt>
                <dd>{selectedDate}</dd>
              </div>
              <div>
                <dt>保存名称</dt>
                <dd>{fundReportFileName(selectedDate)}</dd>
              </div>
              <div>
                <dt>文件大小</dt>
                <dd>{formatSize(selectedFile.size)}</dd>
              </div>
            </dl>
          </section>
        {/if}

        <footer class="upload-actions">
          {#if selectedFile}<span>即将发布 {fundReportFileName(selectedDate)}</span>{/if}
          <Button data-ui-owner="lib-FundReportUploadDialog-svelte" variant="ghost" class={"ui-button  cancel-button"} type="button" disabled={uploading} onclick={() => dialog.close()}>取消</Button>
          <Button data-ui-owner="lib-FundReportUploadDialog-svelte" variant="default" class={"ui-button  upload-button"} type="submit" disabled={!selectedFile || uploading}>
            {#if uploading}<span class="button-spinner" aria-hidden="true"></span>{/if}
            <span>{uploading ? "正在上传" : "上传并发布"}</span>
          </Button>
        </footer>


      </form>
</div>
</Modal>

<style>
  .upload-dialog-body { width: min(720px, 100%); max-width: 720px; padding: 0; }
  .dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--line); }
  .dialog-heading h2 { margin: 0; font-size: 1.25rem; }
  :global(.close-button[data-ui-owner="lib-FundReportUploadDialog-svelte"]) { width: 44px; height: 44px; display: grid; place-items: center; }
  :global(.close-button[data-ui-owner="lib-FundReportUploadDialog-svelte"] svg) { width: 20px; fill: none; stroke: currentColor; stroke-width: 2; }
  :global(.cancel-button[data-ui-owner="lib-FundReportUploadDialog-svelte"]) { padding: 10px 16px; }
  .file-picker-icon svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .upload-form {
    display: grid;
    gap: 20px;
    padding: 24px;
  }

  :global(.upload-file-input[data-ui-owner="lib-FundReportUploadDialog-svelte"]) {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  :global(.file-picker[data-ui-owner="lib-FundReportUploadDialog-svelte"]) {
    display: grid;
    min-height: 124px;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    align-items: center;
    gap: 16px;
    padding: 20px 22px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-inner);
    color: var(--brand-deep);
    background: color-mix(in srgb, var(--brand-soft) 36%, var(--surface));
    text-align: left;
    cursor: pointer;
    transition:
      border-color 160ms ease,
      background 160ms ease,
      box-shadow 160ms ease;
  }

  :global(.file-picker[data-ui-owner="lib-FundReportUploadDialog-svelte"]:hover:not(:disabled)) {
    border-color: var(--brand);
    background: var(--brand-soft);
    box-shadow: 0 8px 24px rgb(47 111 214 / 9%);
  }

  :global(.file-picker[data-ui-owner="lib-FundReportUploadDialog-svelte"].selected) {
    border-style: solid;
    border-color: color-mix(in srgb, var(--green) 46%, var(--line));
    background: color-mix(in srgb, var(--green) 7%, var(--surface));
  }

  .file-picker-icon {
    display: grid;
    width: 56px;
    height: 56px;
    place-items: center;
    border-radius: var(--radius-control);
    color: var(--brand-deep);
    background: var(--surface);
    box-shadow: var(--shadow-card);
  }

  :global(.selected[data-ui-owner="lib-FundReportUploadDialog-svelte"]) .file-picker-icon {
    color: color-mix(in srgb, var(--green) 82%, #173b31);
  }

  .file-picker-icon svg {
    width: 30px;
  }

  .file-picker-copy {
    display: grid;
    min-width: 0;
    gap: 6px;
  }

  .file-picker-copy strong {
    color: var(--ink);
    font-size: 1.125rem;
    font-weight: bold;
    overflow-wrap: anywhere;
  }

  .file-picker-action {
    min-height: 40px;
    padding: 9px 13px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    color: var(--brand-deep);
    background: var(--surface);
    font-size: 0.875rem;
    font-weight: bold;
  }

  .selected-file {
    padding: 0 2px;
  }

  .selected-file dl {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin: 0;
  }

  .selected-file dl > div {
    display: grid;
    min-width: 0;
    gap: 5px;
    padding: 13px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-inner);
    background: var(--panel);
  }

  .selected-file dt {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .selected-file dd {
    margin: 0;
    color: var(--text-2);
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .upload-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
  }

  .upload-actions > span {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  :global(.upload-button[data-ui-owner="lib-FundReportUploadDialog-svelte"]) {
    display: inline-flex;
    min-width: 168px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 18px;
    min-height: 46px;
  }

  :global(.upload-button[data-ui-owner="lib-FundReportUploadDialog-svelte"]:disabled),
  :global(.file-picker[data-ui-owner="lib-FundReportUploadDialog-svelte"]:disabled) {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .button-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgb(255 255 255 / 40%);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 720px) {
    :global(.file-picker[data-ui-owner="lib-FundReportUploadDialog-svelte"]) { grid-template-columns: 48px minmax(0, 1fr); padding: 16px;
    min-height: 124px; }
    .file-picker-action { display: none; }
    .selected-file dl { grid-template-columns: 1fr; }
    .upload-actions { flex-wrap: wrap; }
    .upload-actions > span { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { .button-spinner { animation: none; } }
</style>
