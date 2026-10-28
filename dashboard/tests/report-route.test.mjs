import assert from "node:assert/strict";
import test from "node:test";

import {
  pathnameForReportView,
  reportViewFromPathname,
} from "../src/report-route.ts";

test("报告 URL 映射到对应视图", () => {
  assert.equal(reportViewFromPathname("/market-briefing"), "visual");
  assert.equal(reportViewFromPathname("/market-briefing/"), "visual");
  assert.equal(reportViewFromPathname("/market-briefing/text"), "text");
  assert.equal(reportViewFromPathname("/market-briefing/text/"), "text");
});

test("报告视图生成稳定的无尾斜杠 URL", () => {
  assert.equal(pathnameForReportView("visual"), "/market-briefing");
  assert.equal(pathnameForReportView("text"), "/market-briefing/text");
});
