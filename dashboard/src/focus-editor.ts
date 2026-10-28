export type FocusFormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "emphasis";

export const FOCUS_STORAGE_PREFIX = "dm-market-report:focus-rich:v1:";
export const LEGACY_FOCUS_STORAGE_PREFIX =
  "dm-market-report:widescreen-focus:v1:";

interface FocusShortcut {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function focusFormatCommand(
  shortcut: FocusShortcut,
): FocusFormatCommand | null {
  if (!shortcut.ctrlKey && !shortcut.metaKey) return null;
  const key = shortcut.key.toLowerCase();
  if (key === "b" && !shortcut.shiftKey) return "bold";
  if (key === "i" && !shortcut.shiftKey) return "italic";
  if (key === "u" && !shortcut.shiftKey) return "underline";
  if (key === "h" && shortcut.shiftKey) return "emphasis";
  return null;
}

export function normalizeFocusText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainTextToFocusHtml(value: string): string {
  return escapeHtml(normalizeFocusText(value)).replace(/\n/g, "<br>");
}

export function focusHtmlToPlainText(value: string): string {
  if (!value) return "";
  const container = document.createElement("div");
  container.innerHTML = value;
  for (const lineBreak of container.querySelectorAll("br")) {
    lineBreak.replaceWith(document.createTextNode("\n"));
  }
  for (const block of container.querySelectorAll("div, p, li")) {
    block.append(document.createTextNode("\n"));
  }
  return normalizeFocusText(container.textContent ?? "");
}

export function loadStoredFocusText(reportDate: string): string {
  if (!reportDate) return "";
  try {
    const saved = window.localStorage.getItem(
      `${FOCUS_STORAGE_PREFIX}${reportDate}`,
    );
    if (saved) return focusHtmlToPlainText(saved);
    return normalizeFocusText(
      window.localStorage.getItem(
        `${LEGACY_FOCUS_STORAGE_PREFIX}${reportDate}`,
      ) ?? "",
    );
  } catch {
    return "";
  }
}

export function saveStoredFocusText(
  reportDate: string,
  value: string,
): void {
  if (!reportDate) return;
  try {
    const normalized = normalizeFocusText(value);
    if (normalized) {
      window.localStorage.setItem(
        `${FOCUS_STORAGE_PREFIX}${reportDate}`,
        plainTextToFocusHtml(normalized),
      );
    } else {
      window.localStorage.removeItem(`${FOCUS_STORAGE_PREFIX}${reportDate}`);
    }
  } catch {
    // In-memory report data remains authoritative when storage is unavailable.
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
