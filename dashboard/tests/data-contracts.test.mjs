import assert from "node:assert/strict";
import test from "node:test";

import { governmentBondsSchema, todayTradesSchema } from "../src/data-contracts.ts";

test("国债收益率缺失时保留 null，兼容直接列表和旧 envelope，其他错型仍拒绝", () => {
  const base = {
    ordinateName: "国债", abscissaName: "10Y", bondCode: "260011.IB",
    tradeNum: 20, yieldSubYtdCloseBp: null,
  };
  for (const value of [null, undefined, "--", ""]) {
    const rows = [{ ...base, yield: value }];
    for (const payload of [rows, { data: rows }]) {
      assert.deepEqual(governmentBondsSchema.parse(payload), [{ ...base, yield: null }]);
    }
  }
  for (const value of ["不是收益率", {}, true, Infinity]) {
    assert.throws(() => governmentBondsSchema.parse([{ ...base, yield: value }]));
  }
});

test("今日成交缺少收益率时归一为 null，其他错型仍拒绝", () => {
  assert.deepEqual(todayTradesSchema.parse([{
    bondUniCode: "101",
    remainingTenor: "3Y",
  }]), [{
    bondUniCode: "101",
    remainingTenor: "3Y",
    tradeYield: null,
  }]);

  assert.throws(() => todayTradesSchema.parse([{
    bondUniCode: "101",
    remainingTenor: "3Y",
    tradeYield: "不是收益率",
  }]));
});
