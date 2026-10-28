import { afterEach, expect, test, vi } from "vitest";
import { loadTradingDay } from "../src/trading-calendar";
import { fetchChoiceTable } from "../src/choice/client";
vi.mock("../src/choice/client", () => ({ fetchChoiceTable: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(fetchChoiceTable).mockReset(); });
const date = "2026-10-01";
const result = { date, isTradingDay: false, previousTradingDate: "2026-09-30" };
function cache() {
  const entries = new Map<string, Response>();
  const storage = { match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()), put: vi.fn(async (key: Request, value: Response) => { entries.set(key.url, value.clone()); }) };
  vi.stubGlobal("caches", { open: async () => storage });
  return { storage, entries };
}
function upstream() { vi.mocked(fetchChoiceTable).mockResolvedValue({ function: "TRADEDATES", fields: ["date"], rows: [{ date: "2026-09-30" }] }); }
test("validated market closures are cached by date; expiry causes another lookup", async () => {
  const c = cache(); upstream();
  expect(await loadTradingDay({} as Env, date)).toEqual(result);
  expect(await loadTradingDay({} as Env, date)).toEqual(result);
  expect(fetchChoiceTable).toHaveBeenCalledTimes(1);
  c.entries.clear();
  expect(await loadTradingDay({} as Env, date)).toEqual(result);
  expect(fetchChoiceTable).toHaveBeenCalledTimes(2);
});
test("cache failures do not discard a valid upstream calendar", async () => {
  const c = cache(); upstream();
  c.storage.match.mockRejectedValue(new Error("cache unavailable"));
  c.storage.put.mockRejectedValue(new Error("cache unavailable"));
  expect(await loadTradingDay({} as Env, date)).toEqual(result);
});
test("wrong-date cached values are ignored", async () => {
  const c = cache(); upstream();
  c.entries.set(`https://eastmoney.hasbai.xyz/_cache/trading-days/CNSESH/${date}`, Response.json({ ...result, date: "2026-09-30" }));
  expect(await loadTradingDay({} as Env, date)).toEqual(result);
  expect(fetchChoiceTable).toHaveBeenCalledTimes(1);
});
test.each([{ rows: [] }, { rows: [{ date: "2026-09-30" }, { date: "invalid" }] }, { rows: [{ date: "2026-10-02" }] }])("invalid upstream calendar cannot be cached as a closure", async ({ rows }) => {
  const c = cache();
  vi.mocked(fetchChoiceTable).mockResolvedValue({ function: "TRADEDATES", fields: ["date"], rows });
  await expect(loadTradingDay({} as Env, date)).rejects.toThrow();
  expect(c.storage.put).not.toHaveBeenCalled();
});
