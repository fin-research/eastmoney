import { AsyncLocalStorage } from "node:async_hooks";

export function recordingCreditTracing() {
  const context = new AsyncLocalStorage();
  const spans = [];
  const tracing = { enterSpan(name, callback, ...args) {
    const span = { name, parent: context.getStore(), attributes: {}, ended: false, isTraced: true,
      setAttribute(key, value) { this.attributes[key] = value; return this; } };
    spans.push(span);
    return context.run(span, async () => {
      try { return await callback(span, ...args); }
      finally { span.ended = true; }
    });
  } };
  return { tracing, spans };
}
