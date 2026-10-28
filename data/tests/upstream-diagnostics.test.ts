import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/app";
import { readUpstreamError, readUpstreamJson, UpstreamPayloadError, diagnosticBody, redactDiagnosticText } from "../src/upstream-diagnostics";
import { allowRateLimits } from "./rate-limit-bindings";

function env(source: "DM" | "CHOICE_RPC", fetch: (request: Request) => Promise<Response>): Cloudflare.Env {
  return { DM_COOKIE: "device_id=private-device; session=private-session", CHOICE_RPC_TOKEN: "private-rpc-token",
    ...allowRateLimits(),
    [source]: { fetch },
  } as unknown as Cloudflare.Env;
}
const historyUrl = "https://example.test/cfets-histories?bondCode=DR001&endCapitalTime=1788969615000&limit=100";
const edbUrl = "https://example.test/choice/edb?edbIds=E1000172&startDate=2026-09-01&endDate=2026-09-10";

describe("upstream diagnostics", () => {
  it("retains DM HTTP status and body while redacting echoed cookie values and headers", async () => {
    const response = await handleRequest(new Request(historyUrl), env("DM", async () => Response.json({
      code: "MAINTENANCE", message: "maintenance window", cookie: "session=private-session",
      request: "device private-device", token: "other-secret", nested: { authorization: "Bearer other-secret" },
    }, { status: 502, headers: { "X-Request-Id": "dm-trace-123", "Set-Cookie": "session=private-session" } })));
    expect(response.status).toBe(503);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.error).toMatchObject({ source: "DM", stage: "fetch", upstreamStatus: 502,
      upstreamResponse: { status: 502, requestId: "dm-trace-123", truncated: false } });
    expect(JSON.parse(body.error.upstreamResponse.body)).toMatchObject({ code: "MAINTENANCE", message: "maintenance window" });
    expect(text).not.toMatch(/private-session|private-device|other-secret|set-cookie/i);
  });

  it("retains Choice SDK error code and raw redacted response", async () => {
    const response = await handleRequest(new Request(edbUrl), env("CHOICE_RPC", async () => Response.json({
      error: { code: 10003008, message: "invalid stock code", diagnostic: "private-rpc-token", token: "echoed-secret" },
    }, { status: 503 })));
    const body = await response.json() as { detail: string; error: Record<string, unknown> };
    expect(body.detail).toBe("invalid stock code");
    expect(body.error).toMatchObject({ upstreamCode: 10003008, upstreamStatus: 503, upstreamPath: "/rpc/v1/choice/edb" });
    expect(JSON.stringify(body)).not.toMatch(/private-rpc-token|echoed-secret/);
    expect(JSON.stringify(body)).toContain("10003008");
  });

  it("preserves the numeric Choice permission code from the real RPC envelope", async () => {
    const response = await handleRequest(new Request(edbUrl), env("CHOICE_RPC", async () => Response.json({
      error: { code: "CHOICE_UPSTREAM", upstreamCode: 10001003, message: "user has no access for this API", retryable: true },
    }, { status: 503 })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { upstreamCode: 10001003 } });
  });

  it("retains the decoded DM protobuf business code and message", async () => {
    const message = new TextEncoder().encode("nightly maintenance private-session");
    const envelope = Uint8Array.from([8, 42, 18, message.length, ...message]);
    const response = await handleRequest(new Request(historyUrl), env("DM", async () => new Response(new Uint8Array(deflateSync(envelope)))));
    const body = await response.json() as { detail: string; error: { upstreamCode: number; upstreamResponse: { body: string } } };
    expect(response.status).toBe(503);
    expect(body.error.upstreamCode).toBe(42);
    expect(body.error.upstreamResponse.body).toContain("nightly maintenance");
    expect(JSON.stringify(body)).not.toContain("private-session");
  });

  it("captures HTML masquerading as a successful protobuf or Choice JSON response", async () => {
    for (const source of ["DM", "CHOICE_RPC"] as const) {
      const response = await handleRequest(new Request(source === "DM" ? historyUrl : edbUrl), env(source, async () => new Response(
        "<html>upstream maintenance</html>", { headers: { "Content-Type": "text/html", "X-Choice-Rpc-Version": "choice.rpc.v1" } },
      )));
      const body = await response.json() as { error: { stage: string; upstreamResponse: { body: string; status: number } } };
      expect(response.status).toBe(503);
      expect(body.error.stage).toBe("decode");
      expect(body.error.upstreamResponse.body).toContain("upstream maintenance");
      expect(body.error.upstreamResponse.status).toBe(200);
    }
  });

  it("records network failure cause with source and path without leaking the signed URL", async () => {
    const response = await handleRequest(new Request(historyUrl), env("DM", async () => {
      throw new Error("connection reset https://rest.innodealing.com/test?sign=private-sign&device_id=private-device session=private-session");
    }));
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "UPSTREAM_NETWORK_ERROR", source: "DM", cause: { name: "Error" } } });
    expect(JSON.stringify(body)).toContain("connection reset");
    expect(JSON.stringify(body)).not.toMatch(/private-sign|private-device|private-session/);
  });

  it("bounds error streaming and cancels oversized bodies", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("maintenance " + "x".repeat(10_000)));
    }, cancel }), { status: 503 });
    const details = await readUpstreamError(response);
    expect(details.body.length).toBeLessThanOrEqual(8192);
    expect(details.truncated).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("redacts nested secrets while retaining non-secret diagnostics", () => {
    const json = diagnosticBody(JSON.stringify({ code: "E503", details: { password: "hidden", nested: [{ api_token: "hidden" }] } }));
    expect(json).not.toContain("hidden");
    expect(json).toContain("E503");
    expect(redactDiagnosticText("Authorization: Bearer hidden\npassword=hidden")).not.toContain("hidden");
  });
});

describe("bounded upstream JSON decoding", () => {
  const encoder = new TextEncoder();
  function chunksResponse(chunks: Uint8Array[]) {
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } }));
  }

  it("preserves mixed chunk order, split UTF-8, and a BOM inside a JSON string", async () => {
    const value = { text: "a".repeat(8180) + "债券😀\uFEFF" + "b".repeat(20000) };
    const bytes = encoder.encode("\uFEFF" + JSON.stringify(value));
    const sizes = [1, 2, 1024, 7170, 1, 20000, 1];
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (const size of sizes) { chunks.push(bytes.subarray(offset, offset + size)); offset += size; }
    chunks.push(bytes.subarray(offset));
    expect(await readUpstreamJson(chunksResponse(chunks), [])).toEqual(value);
  });

  it("accepts exactly 8MiB and cancels a stream one byte beyond the limit", async () => {
    const limit = 8 * 1024 * 1024;
    const valid = encoder.encode('"' + 'x'.repeat(limit - 2) + '"');
    expect((await readUpstreamJson(chunksResponse([valid.subarray(0, 1024), valid.subarray(1024)]), []) as string).length).toBe(limit - 2);
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(valid);
      controller.enqueue(encoder.encode(" "));
    }, cancel }));
    await expect(readUpstreamJson(response, [])).rejects.toThrow(`Upstream JSON exceeds ${limit} bytes`);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains a redacted buffered prefix when reading fails", async () => {
    let reads = 0;
    const response = new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(encoder.encode('{"message":"maintenance private-session"'));
      else controller.error(new Error("connection reset private-session"));
    } }));
    try {
      await readUpstreamJson(response, ["private-session"]);
      expect.fail("expected stream failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamPayloadError);
      expect((error as UpstreamPayloadError).details.body).toContain("maintenance");
      expect((error as Error).message).toContain("connection reset");
      expect((error as Error).message).not.toContain("private-session");
      expect(JSON.stringify(error)).not.toContain("private-session");
    }
  });
});
