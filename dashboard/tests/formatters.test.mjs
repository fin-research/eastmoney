import assert from "node:assert/strict";
import test from "node:test";

import {
  formatOmoNetAmount,
  integer,
  signed,
} from "../src/formatters.ts";

test("OMO 汇总以正负号表示净投放和净回笼", () => {
  assert.equal(formatOmoNetAmount(20), "+20 亿");
  assert.equal(formatOmoNetAmount(-80), "−80 亿");
  assert.equal(formatOmoNetAmount(0), "0 亿");
});

test("权益成交额与两融余额及变动均按整数展示", () => {
  assert.equal(integer(25300.51, " 亿元"), "25,301 亿元");
  assert.equal(integer(26676.49, " 亿元"), "26,676 亿元");
  assert.equal(signed(1102.32, " 亿元", 0), "+1,102 亿元");
  assert.equal(signed(-303.09, " 亿元", 0), "−303 亿元");
});
