/** Parse SSE incrementally across UTF-8, line and event boundaries. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  receive: (event: { event: string; data: string }) => void,
  maxBytes: number,
  options: { signal?: AbortSignal; shouldStop?: () => boolean } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", event = "message", data: string[] = [], bytes = 0;
  function line(value: string) {
    if (value === "") {
      if (data.length) receive({ event, data: data.join("\n") });
      event = "message"; data = [];
    } else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    else if (value.startsWith("event:")) event = value.slice(6).trim();
  }
  // Cancellation settles pending reads even if the source's cleanup is slow.
  const abort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      options.signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("AI stream exceeds response size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        if (options.shouldStop?.()) return;
      }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer.replace(/\r$/, ""));
    line("");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    // A protocol terminal frame is enough; do not wait for upstream EOF/cleanup.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
