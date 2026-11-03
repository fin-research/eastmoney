import { connect } from 'cloudflare:sockets';

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export interface ChoiceEndpoint { hostname: string; port: number }
export class ChoiceTransportError extends Error {
  constructor(message: string, readonly timeout = false, readonly upstreamCode?: number) { super(message); this.name = 'ChoiceTransportError'; }
}
export interface NativeFrame { header: Uint8Array; body: Uint8Array }

/** One owned socket; no credentials or upstream response text enter exceptions. */
export class ChoiceConnection {
  private readonly socket: ReturnType<typeof connect>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffered = new Uint8Array(0);
  private closed = false;
  constructor(endpoint: ChoiceEndpoint) {
    this.socket = connect(endpoint, { secureTransport: 'off', allowHalfOpen: false });
    // Observe remote termination even while no request is currently reading.
    void this.socket.closed.catch(() => undefined);
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }
  async deadline<T>(operation: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { void this.close(); reject(new ChoiceTransportError('Choice socket deadline exceeded', true)); }, ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  async send(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new ChoiceTransportError('Choice socket is closed');
    try { await this.socket.opened; await this.writer.write(bytes); }
    catch { throw new ChoiceTransportError('Choice socket write failed'); }
  }
  private async readExact(count: number): Promise<Uint8Array> {
    if (count < 0 || count > MAX_FRAME_BYTES) throw new ChoiceTransportError('Invalid Choice frame size');
    const result = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      if (!this.buffered.length) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await this.reader.read(); } catch { throw new ChoiceTransportError('Choice socket read failed'); }
        if (next.done) throw new ChoiceTransportError('Truncated Choice frame');
        if (next.value.length > MAX_FRAME_BYTES) throw new ChoiceTransportError('Choice socket chunk exceeds limit');
        this.buffered = new Uint8Array(next.value);
      }
      const size = Math.min(count - offset, this.buffered.length);
      result.set(this.buffered.subarray(0, size), offset);
      this.buffered = this.buffered.subarray(size);
      offset += size;
    }
    return result;
  }
  async receive(): Promise<NativeFrame> {
    const header = await this.readExact(13);
    const size = new DataView(header.buffer, header.byteOffset, 13).getUint32(1, true);
    if (size < 13 || size > MAX_FRAME_BYTES) throw new ChoiceTransportError('Invalid Choice receive length');
    let body = await this.readExact(size - 13);
    if (header[7] === 2) {
      const stream = new Blob([new Uint8Array(body).buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      body = await readBounded(stream, MAX_FRAME_BYTES);
    } else if (header[7] !== 0) throw new ChoiceTransportError('Unsupported Choice compression');
    return { header, body };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.socket.close().catch(() => undefined);
  }
}

export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new ChoiceTransportError('Choice body read timed out', true);
      const next = await reader.read();
      if (signal?.aborted) throw new ChoiceTransportError('Choice body read timed out', true);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new ChoiceTransportError('Choice decoded payload exceeds limit');
      chunks.push(next.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function exchange(endpoint: ChoiceEndpoint, request: Uint8Array, timeout = 60_000): Promise<NativeFrame> {
  const connection = new ChoiceConnection(endpoint);
  try { return await connection.deadline(async () => { await connection.send(request); return connection.receive(); }, timeout); }
  finally { await connection.close(); }
}
