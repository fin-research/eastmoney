import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AI_GATEWAY_REASONING_EFFORT_BY_TASK,
  AiGatewayResponseError,
  generateAiGatewayObject,
} from "../src/ai-gateway";

const credentials = {
  accountId: "account-id",
  gatewayId: "default",
  token: "test-token",
};

const options = {
  promptCacheKey: "camel-captcha:v1",
  requestTimeoutMs: 30_000,
  taskType: "summary" as const,
  metadata: { business: "camel_auth", prompt_version: "captcha-v1" },
};

function completedOutput(value: unknown): Response {
  return Response.json({
    status: "completed",
    prompt_cache_key: "camel-captcha:v1",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  });
}

describe("AI Gateway Responses adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the unified provider route and preserves multimodal CAPTCHA input", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => completedOutput({ code: "aB3" }));
    const image = "data:image/png;base64,aW1hZ2U=";

    await expect(
      generateAiGatewayObject(
        credentials,
        [
          { role: "system", content: "system instructions" },
          {
            role: "user",
            content: [
              { type: "input_text", text: "read" },
              { type: "input_image", image_url: image, detail: "high" },
            ],
          },
        ],
        z.object({ code: z.string() }).strict(),
        "camel_captcha",
        options,
        fetcher,
      ),
    ).resolves.toEqual({ code: "aB3" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer test-token");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "null")).toEqual({
      business: "camel_auth",
      prompt_version: "captcha-v1",
      ai_model: "gpt-6-luna",
      ai_provider: "custom-codex",
      ai_provider_attempt: "primary",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      prompt_cache_key: "camel-captcha:v1",
      instructions: "system instructions",
      reasoning: {
        effort: "low",
        summary: "auto",
        context: "current_turn",
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "read" },
            { type: "input_image", image_url: image, detail: "high" },
          ],
        },
      ],
    });
    expect(body).not.toHaveProperty("include");
  });

  it("retries only for retryable provider failures", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let retryableCall = 0;
    const retryable = vi.fn<typeof fetch>(async () =>
      ++retryableCall === 1
        ? new Response("unavailable", { status: 503 })
        : completedOutput({ code: "9Zx" }),
    );
    await expect(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "read" }],
        z.object({ code: z.string() }).strict(),
        "camel_captcha",
        options,
        retryable,
      ),
    ).resolves.toEqual({ code: "9Zx" });
    expect(retryable.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
      "https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses",
    ]);

    const nonRetryable = vi.fn<typeof fetch>(async () =>
      new Response("bad request", { status: 400 }),
    );
    await expect(
      generateAiGatewayObject(
        credentials,
        [{ role: "user", content: "read" }],
        z.object({ code: z.string() }).strict(),
        "camel_captcha",
        options,
        nonRetryable,
      ),
    ).rejects.toBeInstanceOf(AiGatewayResponseError);
    expect(nonRetryable).toHaveBeenCalledOnce();
  });
});


describe("Codex provider contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes every task type to Codex with its configured reasoning effort", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const taskType of Object.keys(AI_GATEWAY_REASONING_EFFORT_BY_TASK) as Array<keyof typeof AI_GATEWAY_REASONING_EFFORT_BY_TASK>) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }],
      }));
      await generateAiGatewayObject(credentials, [{ role: "user", content: "test" }],
        z.object({ ok: z.boolean() }).strict(), "probe", { ...options, taskType }, fetcher);
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect(String(url)).toBe("https://gateway.ai.cloudflare.com/v1/account-id/default/custom-codex/responses");
      expect(JSON.parse(String(init?.body)).reasoning.effort).toBe(AI_GATEWAY_REASONING_EFFORT_BY_TASK[taskType]);
    }
  });

  it.each(["final_answer", undefined])("ignores Codex commentary before a %s structured answer", async (phase) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      status: "completed",
      output: [
        { type: "message", phase: "commentary", content: [{ type: "output_text", text: "I will inspect the input." }] },
        { type: "message", ...(phase ? { phase } : {}), content: [{ type: "output_text", text: '{"ok":true}' }] },
      ],
    }));
    await expect(generateAiGatewayObject(credentials, [{ role: "user", content: "test" }],
      z.object({ ok: z.boolean() }).strict(), "probe", options, fetcher)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
