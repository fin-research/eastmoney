<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { archiveBondLedgerFile } from "./upload";
  import { globalMessages } from "$lib/global-messages";

  interface Props {
    onImported: (latestDate: string) => Promise<void>;
  }

  let { onImported }: Props = $props();
  let input = $state<HTMLInputElement>(null!);
  let uploading = $state(false);

  async function upload(event: Event): Promise<void> {
    const element = event.currentTarget as HTMLInputElement;
    const files = [...(element.files ?? [])];
    element.value = "";
    if (uploading || !files.length) return;
    uploading = true;
    let succeeded = 0;
    let latestDate = "";
    const errors: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        globalMessages.info(`正在上传并导入 ${index + 1}/${files.length}：${file.name}`, {
          key: "bond-ledger-operation", title: "台账处理中", duration: 120_000,
        });
        try {
          const imported = await archiveBondLedgerFile(file);
          if (imported.reportDate > latestDate) latestDate = imported.reportDate;
          succeeded += 1;
        } catch (error) {
          errors.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (succeeded) await onImported(latestDate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      uploading = false;
    }
    const summary = `已导入 ${succeeded}/${files.length} 份台账`;
    if (errors.length) {
      globalMessages.error(`${summary}；${errors.join("；")}`, {
        key: "bond-ledger-operation", title: "台账导入结果", duration: 12_000,
      });
    } else {
      globalMessages.success(summary, { key: "bond-ledger-operation", title: "台账导入完成" });
    }
  }
</script>

<Button data-ui-owner="lib-bond-ledger-BondLedgerUploadButton-svelte" variant="outline" class={"ui-button"} type="button" disabled={uploading} onclick={() => input.click()}>
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 13V3m-3.5 3.5L10 3l3.5 3.5M4 13v4h12v-4" />
  </svg>
  <span>{uploading ? "正在导入" : "上传台账"}</span>
</Button>
<input bind:this={input} type="file" accept=".xlsx" multiple hidden disabled={uploading} aria-label="上传二级池台账" onchange={upload} />

<style>
  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.8;
  }
</style>
