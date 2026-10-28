import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  AI_GATEWAY_REASONING_EFFORT_BY_TASK,
  AiGatewayRetryError,
  AiGatewayResponseError,
  generateAiGatewayObject,
} from "../src/lib/server/ai-gateway.ts";

const credentials = {
  accountId: "account-id",
  gatewayId: "default",
  token: "test-token",
};

const options = {
  promptCacheKey: "probe:v1",
  requestTimeoutMs: 120_000,
  taskType: "summary",
  metadata: { prompt_version: "test-v1" },
};

function responsesOutput(value, status = "completed") {
  return Response.json({
    id: "resp-test",
    object: "response",
    status,
    prompt_cache_key: "probe:v1",
    usage: {
      input_tokens_details: { cached_tokens: 1_024, cache_write_tokens: 0 },
    },
    output: [
      {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "Reviewed the available evidence." },
        ],
        encrypted_content: "encrypted-reasoning",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  });
}

test("optional tracing metadata preserves missing usage and cannot turn successful responses into retries", async () => {
  const received = [];
  let calls = 0;
  const result = await generateAiGatewayObject(credentials, [{ role: "user", content: "private question" }], z.object({ ok: z.boolean() }), "test",
    { ...options, onTelemetry: metadata => { received.push(metadata); throw new Error("tracing collector failed"); } },
    async () => { calls++; return responsesOutput({ ok: true }); });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
  assert.deepEqual(received.at(-1), { status: 200, gatewayLogId: "", inputTokens: undefined, outputTokens: undefined,
    cachedInputTokens: 1024, reasoningTokens: undefined });
  assert.doesNotMatch(JSON.stringify(received), /private question|output_text|summary|encrypted/);
});

test("incomplete Responses retain known token usage without treating invalid token counts as zero", async () => {
  const received = [];
  await assert.rejects(generateAiGatewayObject(credentials, [], z.object({ ok: z.boolean() }), "test",
    { ...options, taskType: "credit_answer", onTelemetry: metadata => received.push(metadata) }, async () => Response.json({
      status: "incomplete", output: [], usage: { input_tokens: 120, output_tokens: -1, output_tokens_details: { reasoning_tokens: "private text" } },
    })), AiGatewayResponseError);
  assert.deepEqual(received.at(-1), { status: 200, gatewayLogId: "", inputTokens: 120, outputTokens: undefined,
    cachedInputTokens: undefined, reasoningTokens: undefined });
});

async function withoutAiLogs(run) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  console.log = (value) => logs.push(String(value));
  console.warn = () => {};
  try {
    return { value: await run(), logs };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

test("direct Responses call uses the custom-codex provider-specific URL", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return responsesOutput({ ok: true });
  };

  const { value: output, logs } = await withoutAiLogs(() =>
    generateAiGatewayObject(
      credentials,
      [
        { role: "system", content: "system" },
        { role: "user", content: "test" },
      ],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    ),
  );

  assert.deepEqual(output, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("cf-aig-authorization"), "Bearer test-token");
  assert.equal(headers.get("cf-aig-skip-cache"), "true");
  assert.equal(headers.get("cf-aig-collect-log"), "true");
  assert.equal(headers.get("cf-aig-request-timeout"), "120000");
  assert.deepEqual(JSON.parse(headers.get("cf-aig-metadata")), {
    prompt_version: "test-v1",
    ai_model: "gpt-6-luna",
    ai_provider: "custom-codex",
    ai_provider_attempt: "primary",
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-6-luna",
    prompt_cache_key: "probe:v1",
    instructions: "system",
    reasoning: {
      effort: "xhigh",
      summary: "auto",
      context: "current_turn",
    },
    text: {
      format: {
        type: "json_schema",
        name: "probe",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
    input: [{ role: "user", content: "test" }],
  });
  assert.equal(Object.hasOwn(JSON.parse(calls[0].init.body), "include"), false);
  assert.match(logs[0], /"provider":"custom-codex"/);
  assert.match(logs[0], /"task_type":"summary"/);
  assert.match(logs[0], /"reasoning_effort":"xhigh"/);
  assert.match(logs[0], /"requested_reasoning_summary":"auto"/);
  assert.match(logs[0], /"requested_reasoning_context":"current_turn"/);
  assert.match(logs[0], /"reasoning_summary_count":1/);
  assert.match(logs[0], /"reasoning_summary_text_length":32/);
  assert.match(logs[0], /"prompt_cache_key":"probe:v1"/);
  assert.match(logs[0], /"cached_input_tokens":1024/);
  assert.match(logs[0], /"encrypted_reasoning_present":true/);
});

test("reasoning effort is fixed by task type", () => {
  assert.deepEqual(AI_GATEWAY_REASONING_EFFORT_BY_TASK, {
    generation: "xhigh",
    market_briefing: "xhigh",
    analysis: "xhigh",
    commentary: "xhigh",
    credit_answer: "xhigh",
    summary: "xhigh",
  });
});

test("structured final answers exclude assistant commentary messages", async () => {
  const { value } = await withoutAiLogs(() => generateAiGatewayObject(credentials,
    [{ role: "user", content: "Find the report" }], z.object({ ok: z.boolean() }), "probe", options,
    async () => Response.json({ status: "completed", output: [
      { type: "message", phase: "commentary", content: [{ type: "output_text", text: "I will check the files." }] },
      { type: "message", phase: "final_answer", content: [{ type: "output_text", text: '{"ok":true}' }] },
    ] })));
  assert.deepEqual(value, { ok: true });
});

test("credit responses allow a bounded larger envelope while validating the final object", async () => {
  const { value } = await withoutAiLogs(() => generateAiGatewayObject(credentials,
    [{ role: "user", content: "Verify the source" }], z.object({ ok: z.boolean() }), "probe", { ...options, taskType: "credit_answer" },
    async () => Response.json({ status: "completed", output: [
      { type: "reasoning", encrypted_content: "x".repeat(3 * 1024 * 1024) },
      { type: "message", phase: "final_answer", content: [{ type: "output_text", text: '{"ok":true}' }] },
    ] })));
  assert.deepEqual(value, { ok: true });
  await assert.rejects(generateAiGatewayObject(credentials, [{ role: "user", content: "test" }],
    z.object({ ok: z.boolean() }), "probe", { ...options, taskType: "credit_answer" },
    async () => new Response("x".repeat(8 * 1024 * 1024 + 1))), /exceeds 8388608 bytes/);
});

test("market briefing enables Responses web search with xhigh reasoning effort", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return responsesOutput({ ok: true });
  };

  const { value } = await withoutAiLogs(() =>
    generateAiGatewayObject(
      credentials,
      [{ role: "user", content: "market briefing" }],
      z.object({ ok: z.boolean() }).strict(),
      "market_briefing",
      {
        ...options,
        taskType: "market_briefing",
        tools: [{ type: "web_search" }],
      },
      fetcher,
    ),
  );

  assert.deepEqual(value, { ok: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.reasoning.effort, "xhigh");
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
});

test("policy commentary enables Responses web search with xhigh reasoning effort", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return responsesOutput({ ok: true });
  };

  const { value } = await withoutAiLogs(() =>
    generateAiGatewayObject(
      credentials,
      [{ role: "user", content: "policy" }],
      z.object({ ok: z.boolean() }).strict(),
      "commentary",
      {
        ...options,
        taskType: "commentary",
        tools: [{ type: "web_search" }],
      },
      fetcher,
    ),
  );

  assert.deepEqual(value, { ok: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.reasoning.effort, "xhigh");
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
});

test("retryable primary failure retries once to direct custom-codex", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response('{"error":{"message":"upstream unavailable"}}', {
        status: 503,
        headers: { "cf-aig-log-id": "log-primary" },
      });
    }
    return responsesOutput({ ok: true });
  };

  const { value: output } = await withoutAiLogs(() =>
    generateAiGatewayObject(
      credentials,
      [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    ),
  );

  assert.deepEqual(output, { ok: true });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
    ],
  );
  assert.deepEqual(
    calls.map(
      (call) => JSON.parse(new Headers(call.init.headers).get("cf-aig-metadata"))
        .ai_provider_attempt,
    ),
    ["primary", "retry"],
  );
});

test("business schema failure retries the same Codex provider", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls === 1
      ? responsesOutput({ ok: "yes" })
      : responsesOutput({ ok: true });
  };

  const { value } = await withoutAiLogs(() =>
    generateAiGatewayObject(
      credentials,
      [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    ),
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 2);
});

test("provider response bodies are bounded before parsing", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls === 1
      ? new Response("", { headers: { "content-length": "2097153" } })
      : responsesOutput({ ok: true });
  };

  const { value } = await withoutAiLogs(() =>
    generateAiGatewayObject(
      credentials,
      [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    ),
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 2);
});

test("non-retryable primary 4xx is not masked by retry", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response('{"error":{"message":"invalid model"}}', {
      status: 400,
      headers: { "cf-aig-log-id": "log-bad-request" },
    });
  };

  await assert.rejects(
    generateAiGatewayObject(
      credentials,
      [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      fetcher,
    ),
    (error) => {
      assert.ok(error instanceof AiGatewayResponseError);
      assert.equal(error.provider, "custom-codex");
      assert.equal(error.status, 400);
      assert.equal(error.gatewayLogId, "log-bad-request");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("local configuration errors are rejected before a provider call", async () => {
  let calls = 0;
  await assert.rejects(
    generateAiGatewayObject(
      { ...credentials, token: "" },
      [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(),
      "probe",
      options,
      async () => {
        calls += 1;
        return responsesOutput({ ok: true });
      },
    ),
    /authentication token is not configured/,
  );
  assert.equal(calls, 0);
});

test("final failure preserves both provider attempts and log ids", async () => {
  const fetcher = async (_url, init) => {
    const retry = JSON.parse(new Headers(init.headers).get("cf-aig-metadata")).ai_provider_attempt === "retry";
    return new Response(
      JSON.stringify({ error: { message: retry ? "retry down" : "primary down" } }),
      {
        status: retry ? 502 : 503,
        headers: { "cf-aig-log-id": retry ? "log-retry" : "log-primary" },
      },
    );
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(),
        "probe",
        options,
        fetcher,
      ),
      (error) => {
        assert.ok(error instanceof AiGatewayRetryError);
        assert.deepEqual(
          error.failures.map((failure) => [failure.provider, failure.gatewayLogId]),
          [
            ["custom-codex", "log-primary"],
            ["custom-codex", "log-retry"],
          ],
        );
        assert.match(error.message, /log-primary/);
        assert.match(error.message, /log-retry/);
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }
});


test("every task type routes directly to Codex with its configured reasoning effort", async () => {
  for (const [taskType, effort] of Object.entries(AI_GATEWAY_REASONING_EFFORT_BY_TASK)) {
    const calls = [];
    await withoutAiLogs(() => generateAiGatewayObject(credentials,
      [{ role: "user", content: "test" }], z.object({ ok: z.boolean() }).strict(), "probe",
      { ...options, taskType }, async (url, init) => {
        calls.push({ url: String(url), init });
        return responsesOutput({ ok: true });
      }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses");
    assert.equal(JSON.parse(calls[0].init.body).reasoning.effort, effort);
  }
});
