import type { InventoryPoint } from "./types.ts";

export function positiveInventoryQuotes(points: InventoryPoint[]): {
  bids: InventoryPoint[];
  offers: InventoryPoint[];
} {
  return {
    bids: points.filter(
      (point) => Number.isFinite(point.bid_yield) && (point.bid_yield ?? 0) > 0,
    ),
    offers: points.filter(
      (point) => Number.isFinite(point.ofr_yield) && (point.ofr_yield ?? 0) > 0,
    ),
  };
}
