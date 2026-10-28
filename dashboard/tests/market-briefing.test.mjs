import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketBriefingPrompt,
  filterMarketBriefingNews,
  generateMarketBriefing,
  generateMarketBriefingFromNews,
  MARKET_BRIEFING_SYSTEM,
  MARKET_BRIEFING_PROMPT_VERSION,
} from "../src/lib/server/market-briefing.ts";

test("用户提示词只包含新闻，稳定 instructions 不含日期或 skill 包装", () => {
  assert.equal(buildMarketBriefingPrompt("【1】正文"), "【1】正文");
  assert.doesNotMatch(MARKET_BRIEFING_SYSTEM, /skill|技能|name:|输出格式|JSON|1、|2、|\d{4}-\d{2}-\d{2}/);
  assert.match(MARKET_BRIEFING_SYSTEM, /100—140字/);
  assert.match(MARKET_BRIEFING_SYSTEM, /联网搜索必须少用、慎用/);
  assert.match(MARKET_BRIEFING_SYSTEM, /不为核验给定材料/);
  assert.match(MARKET_BRIEFING_SYSTEM, /搜索获得必要信息后立即停止/);
});

test("过滤和截断今日聚焦新闻素材", () => {
  const filtered = filterMarketBriefingNews(
    [
      "【1】2026-08-18 08:00:00 DM债市要闻速览（8月18日）\n标签：债市\n正文：\n宏观事件\n\n地方债发行提速\n\n后续内容",
      "【2】2026-08-18 08:01:00 DM利率债午间速览\n标签：债市\n正文：\n资金面平稳\n\n现券方面，收益率下行\n\n后续内容",
      "【3】2026-08-18 08:02:00 A股早盘收盘\n标签：股市\n正文：\n不纳入",
      "【4】2026-08-18 08:03:00 DMI外币资金日评（8月17日）\n标签：其它\n正文：\n不纳入",
      "【5】2026-08-18 08:04:00 DMI离岸债日报0818\n标签：债市\n正文：\n不纳入",
      "【6】2026-08-18 08:05:00 保留新闻\n标签：宏观\n正文：\n保留正文",
    ].join("\n\n"),
  );

  assert.equal(
    filtered,
    [
      "【1】2026-08-18 08:00:00 DM债市要闻速览（8月18日）\n标签：债市\n正文：\n宏观事件",
      "【2】2026-08-18 08:01:00 DM利率债午间速览\n标签：债市\n正文：\n资金面平稳",
      "【3】2026-08-18 08:05:00 保留新闻\n标签：宏观\n正文：\n保留正文",
    ].join("\n\n"),
  );
});

test("生成流程从后端取数并直连 provider-specific Responses 结构化输出", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const aiCalls = [];
  const dataCalls = [];
  console.log = () => {};
  const dataFetch = async (url) => {
    const target = url instanceof Request ? url.url : String(url);
    dataCalls.push(target);
    if (target.includes("/data/stock-summary")) {
      assert.equal(
        target,
        "https://eastmoney.hasbai.xyz/data/stock-summary?date=2026-08-10&fields=title,time,paragraphs",
      );
      return new Response(
        JSON.stringify({
          title: "A股收评",
          time: "2026-08-10T15:00:00+08:00",
          paragraphs: ["股市收盘正文"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/data/news?")) {
      const query = new URL(target).searchParams;
      assert.equal(query.get('detail'), 'true');
      assert.equal(query.get('pageSize'), '10');
      assert.equal(query.get('offset'), '0');
      return Response.json([
          {
            sentimentId: "news-1",
            title: "债市要闻",
            time: "2026-08-10T14:30:00+08:00",
            tags: ["债市"],
            important: true,
            content: "债市新闻正文",
          },
      ]);
    }
    if (target.includes("/data/news/news-1?")) {
      return Response.json({
        sentimentId: "news-1",
        title: "债市要闻",
        time: "2026-08-10T14:30:00+08:00",
        tags: ["债市"],
        content: "债市新闻正文",
      });
    }
    throw new Error(`unexpected Data request: ${target}`);
  };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/custom-codex/responses")) {
      aiCalls.push({ url: target, init });
      return Response.json(
        {
          id: "resp-briefing",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    stock: "股市结论。", bond: "债市结论。",
                  }),
                },
              ],
            },
          ],
        },
        { headers: { "cf-aig-log-id": "log-briefing" } },
      );
    }
    throw new Error(`unexpected HTTP request: ${target}`);
  };
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    AI_GATEWAY_ID: "default",
    CF_AIG_TOKEN: "test-token",
    DATA_API_BASE_URL: "https://eastmoney.hasbai.xyz/data",
    DATA: { fetch: dataFetch },
  };
  try {
    const result = await generateMarketBriefing(env, "2026-08-10");
    assert.deepEqual(result, {
      report_date: "2026-08-10",
      stock: "股市结论。", bond: "债市结论。",
      news_count: 2,
    });
    assert.equal(dataCalls.length, 2);
    assert.equal(
      aiCalls[0].url,
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
    );
    const headers = new Headers(aiCalls[0].init.headers);
    assert.equal(headers.get("cf-aig-authorization"), "Bearer test-token");
    assert.equal(headers.get("cf-aig-request-timeout"), "300000");
    assert.deepEqual(JSON.parse(headers.get("cf-aig-metadata")), {
      report_date: "2026-08-10",
      prompt_version: MARKET_BRIEFING_PROMPT_VERSION,
      tags: "market-briefing,manual-generation,web-search",
      ai_model: "gpt-6-luna",
      ai_provider: "custom-codex",
      ai_provider_attempt: "primary",
    });
    const query = JSON.parse(aiCalls[0].init.body);
    assert.equal(query.model, "gpt-6-luna");
    assert.equal(Object.hasOwn(query, "store"), false);
    assert.equal(
      query.prompt_cache_key,
      `market-briefing:${MARKET_BRIEFING_PROMPT_VERSION}`,
    );
    assert.deepEqual(query.reasoning, {
      effort: "xhigh",
      summary: "auto",
      context: "current_turn",
    });
    assert.deepEqual(query.tools, [{ type: "web_search" }]);
    assert.equal(Object.hasOwn(query, "include"), false);
    assert.equal(query.text.format.type, "json_schema");
    assert.equal(query.text.format.name, "market_briefing");
    assert.equal(query.text.format.strict, true);
    assert.deepEqual(query.text.format.schema.required, ["stock", "bond"]);
    assert.ok(aiCalls[0].init.signal instanceof AbortSignal);
    assert.equal(query.instructions, MARKET_BRIEFING_SYSTEM);
    assert.doesNotMatch(query.instructions, /2026-08-10|股市收盘正文/);
    assert.match(query.input[0].content, /^【1】/);
    assert.equal(query.input.length, 1);
    assert.match(query.input[0].content, /【1】2026-08-10 15:00:00 A股收评/);
    assert.match(query.input[0].content, /股市收盘正文/);
    assert.match(query.input[0].content, /【2】2026-08-10 14:30:00 债市要闻/);
    assert.match(query.input[0].content, /债市新闻正文/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});


test("Workflow AI 单次尝试且只使用传入新闻，失败交给step重试", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ error: { message: "unavailable" } }, { status: 503 });
  });
  const env = { CLOUDFLARE_ACCOUNT_ID: "account", AI_GATEWAY_ID: "default", CF_AIG_TOKEN: "test",
    DATA: { fetch: () => { throw new Error("must not refetch news"); } } };
  await assert.rejects(generateMarketBriefingFromNews(env, "2026-08-25",
    { news_text: "持久化的新闻材料", news_count: 2 }, { retry: false }), /HTTP 503/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.input[0].content, "持久化的新闻材料");
});
