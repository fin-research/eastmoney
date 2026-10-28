<script lang="ts">

  import {
    FOCUS_STORAGE_PREFIX,
    LEGACY_FOCUS_STORAGE_PREFIX,
    focusFormatCommand,
    focusHtmlToPlainText,
    normalizeFocusText,
    plainTextToFocusHtml,
  } from "../focus-editor";
  import type { MarketBriefing } from "../types";


  interface Props {
    generating?: boolean;
    disabled?: boolean;
    reportDate: string;
    generatedBriefing?: MarketBriefing | null;
    initialText?: string;
    finalizedAt?: string | null;
    onTextChange?: (value: string) => void;
    onBriefingApplied?: (value: MarketBriefing) => void;
  }

  let {
    generating = false,
    disabled = false,
    reportDate,
    generatedBriefing = null,
    initialText = "",
    finalizedAt = null,
    onTextChange = () => {},
    onBriefingApplied = () => {}
  }: Props = $props();

  let editor = $state<HTMLDivElement>(null!);
  let loadedSource = $state("");
  let html = $state("");
  let empty = $state(true);
  let appliedBriefing = $state<MarketBriefing | null>(null);





  function save(): void {
    if (!reportDate) return;
    html = editor.innerHTML;
    const normalized = normalizeFocusText(editor.innerText);
    empty = !normalized;
    onTextChange(normalized);
    try {
      if (normalized) {
        window.localStorage.setItem(
          `${FOCUS_STORAGE_PREFIX}${reportDate}`,
          html,
        );
      } else {
        window.localStorage.removeItem(
          `${FOCUS_STORAGE_PREFIX}${reportDate}`,
        );
      }
    } catch {
      // The editor remains usable if browser storage is unavailable.
    }
  }

  function format(event: KeyboardEvent): void {
    const command = focusFormatCommand(event);
    if (!command) return;
    event.preventDefault();
    editor.focus();
    if (command === "emphasis") {
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("foreColor", false, themeColor());
    } else {
      document.execCommand(command, false);
    }
    save();
  }

  function pastePlainText(event: ClipboardEvent): void {
    event.preventDefault();
    document.execCommand(
      "insertText",
      false,
      event.clipboardData?.getData("text/plain") ?? "",
    );
    save();
  }

  function visibleText(value: string): boolean {
    return Boolean(focusHtmlToPlainText(value));
  }

  function migrateLegacyEmphasis(value: string): string {
    const container = document.createElement("div");
    container.innerHTML = value;
    for (const element of container.querySelectorAll<HTMLElement>("[style]")) {
      if (!element.style.backgroundColor) continue;
      element.style.removeProperty("background-color");
      element.style.color = themeColor();
      if (!element.style.length) element.removeAttribute("style");
    }
    return container.innerHTML;
  }

  function themeColor(): string {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--color-primary")
      .trim();
  }
  $effect(() => {
    if (
      reportDate &&
      `${reportDate}:${finalizedAt ?? "draft"}` !== loadedSource
    ) {
      loadedSource = `${reportDate}:${finalizedAt ?? "draft"}`;
      try {
        const saved = window.localStorage.getItem(
          `${FOCUS_STORAGE_PREFIX}${reportDate}`,
        );
        const legacy = window.localStorage.getItem(
          `${LEGACY_FOCUS_STORAGE_PREFIX}${reportDate}`,
        );
        html = finalizedAt
          ? plainTextToFocusHtml(initialText)
          : saved
            ? migrateLegacyEmphasis(saved)
            : plainTextToFocusHtml(legacy ?? "");
        if (saved && html !== saved) {
          window.localStorage.setItem(
            `${FOCUS_STORAGE_PREFIX}${reportDate}`,
            html,
          );
        }
        empty = !visibleText(html);
        onTextChange(focusHtmlToPlainText(html));
      } catch {
        html = plainTextToFocusHtml(initialText);
        empty = !visibleText(html);
        onTextChange(focusHtmlToPlainText(html));
      }
    }
  });
  $effect(() => {
    if (
      generatedBriefing &&
      generatedBriefing !== appliedBriefing &&
      generatedBriefing.report_date === reportDate
    ) {
      appliedBriefing = generatedBriefing;
      html = plainTextToFocusHtml(`1、${generatedBriefing.stock}\n2、${generatedBriefing.bond}`);
      empty = !visibleText(html);
      onTextChange(focusHtmlToPlainText(html));
      try {
        window.localStorage.setItem(
          `${FOCUS_STORAGE_PREFIX}${reportDate}`,
          html,
        );
      } catch {
        // The generated text remains editable if browser storage is unavailable.
      }
      onBriefingApplied(generatedBriefing);
    }
  });
</script>

<div
  bind:this={editor}
  class="focus-editor"
  contenteditable="true"
  inert={generating || disabled}
  role="textbox"
  aria-label="输入今日聚焦"
  aria-keyshortcuts="Control+B Meta+B Control+I Meta+I Control+U Meta+U Control+Shift+H Meta+Shift+H"
  aria-multiline="true"
  data-empty={empty}
  data-placeholder=""
  spellcheck="false"
  tabindex="0"
  bind:innerHTML={html}
  onkeydown={format}
  oninput={save}
  onpaste={pastePlainText}
></div>
