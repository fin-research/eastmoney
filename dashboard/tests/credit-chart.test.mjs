import assert from "node:assert/strict";
import test from "node:test";

import { positiveInventoryQuotes } from "../src/positive-quotes.ts";

test("东财债券图表不为零 Bid/Ofr 建立散点系列", () => {
  const zero = {
    bond_name: "25东财G1", tenor_label: "1Y", tenor_years: 1,
    valuation: 1.7, trade_yield: null, trade_spread_bp: null,
    bid_yield: 0, ofr_yield: 0,
  };
  const positive = { ...zero, bond_name: "25东财G2", bid_yield: 1.71, ofr_yield: 1.69 };
  const { bids, offers } = positiveInventoryQuotes([zero, positive]);
  assert.deepEqual(bids.map((point) => point.bond_name), ["25东财G2"]);
  assert.deepEqual(offers.map((point) => point.bond_name), ["25东财G2"]);
});
