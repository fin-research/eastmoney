import assert from "node:assert/strict";
import test from "node:test";

import { reportImageFilename } from "../src/export-filename.ts";

test("导出图片文件名不包含倍率标记，并区分移动端", () => {
  assert.equal(
    reportImageFilename("2026-08-20", false),
    "资金管理部-市场点评-2026-08-20.png",
  );
  assert.equal(
    reportImageFilename("2026-08-20", true),
    "资金管理部-市场点评-2026-08-20-移动端.png",
  );
});
