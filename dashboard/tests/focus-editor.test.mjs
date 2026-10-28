import assert from "node:assert/strict";
import test from "node:test";

import {
  focusFormatCommand,
  normalizeFocusText,
  plainTextToFocusHtml,
} from "../src/focus-editor.ts";

test("纯文本归一化保留段落并移除多余空白", () => {
  assert.equal(
    normalizeFocusText("  第一段\u00a0 \r\n\r\n\r\n第二段  "),
    "第一段\n\n第二段",
  );
});

test("今日聚焦快捷键映射支持 Ctrl 和 Command", () => {
  assert.equal(
    focusFormatCommand({
      key: "b",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }),
    "bold",
  );
  assert.equal(
    focusFormatCommand({
      key: "I",
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    }),
    "italic",
  );
  assert.equal(
    focusFormatCommand({
      key: "u",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }),
    "underline",
  );
  assert.equal(
    focusFormatCommand({
      key: "h",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    }),
    "emphasis",
  );
});

test("旧版纯文本草稿迁移为无额外段落边距的 HTML", () => {
  assert.equal(
    plainTextToFocusHtml("第一条\n第二条 <判断>"),
    "第一条<br>第二条 &lt;判断&gt;",
  );
});
