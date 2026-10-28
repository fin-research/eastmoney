import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStockMarketArticle } from "../src/eastmoney";
import { allowRateLimits } from "./rate-limit-bindings";

const date = "2026-09-15";
const articleUrl = "https://finance.eastmoney.com/a/20260915.html";
const row = { title: "A股指数收评：成交额回升", showTime: `${date} 15:00:00`, uniqueUrl: articleUrl };
afterEach(() => vi.restoreAllMocks());

describe("stock closing article discovery", () => {
  it("selects the requested day's closing article and preserves paragraph order", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: { list: [
        { ...row, showTime: "2026-09-14 15:00:00" },
        { ...row, title: "A股午评", showTime: `${date} 11:30:00` },
        row,
      ] } }))
      .mockResolvedValueOnce(new Response('<div id="ContentBody"><p>成交额<b>回升</b>。</p><p>债市&amp;股市。</p><p>后续观察。</p></div><p>广告</p>'));
    const result = await fetchStockMarketArticle(date, allowRateLimits());
    expect(result).toMatchObject({ title: row.title, url: articleUrl,
      paragraphs: ["成交额回升。", "债市&股市。", "后续观察。"],
      summary_paragraphs: ["成交额回升。", "债市&股市。"] });
    expect(fetcher.mock.calls[1]?.[0]).toBe(articleUrl);
  });

  it("does not fetch off-site links or substitute another day's article", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { list: [
      { ...row, uniqueUrl: "https://eastmoney.com.evil.invalid/article" },
      { ...row, showTime: "2026-09-14 15:00:00" },
    ] } }));
    await expect(fetchStockMarketArticle(date, allowRateLimits())).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed JSON", () => new Response("not JSON")],
    ["invalid list contract", () => Response.json({ data: { list: {} } })],
    ["upstream failure", () => new Response("unavailable", { status: 503 })],
  ])("reports %s as an upstream failure", async (_name, response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    await expect(fetchStockMarketArticle(date, allowRateLimits())).rejects.toMatchObject({ status: 503 });
  });

  it("reports a missing article body instead of a successful empty report", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: { list: [row] } }))
      .mockResolvedValueOnce(new Response('<div id="ContentBody"></div>'));
    await expect(fetchStockMarketArticle(date, allowRateLimits())).rejects.toMatchObject({ status: 503 });
  });
});
